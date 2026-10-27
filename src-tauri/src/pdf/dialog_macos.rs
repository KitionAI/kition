//! macOS: prints a PDF a kit hands over (KitFiles `files/print`) with the
//! system's print panel, as a sheet on the window that asked. PDFKit lays the
//! document's own pages out, so the PDF prints as it is, never re-rendered.

use std::cell::RefCell;
use std::ffi::c_void;

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject, NSObjectProtocol};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSWindow};
use objc2_foundation::{NSData, NSString};
use tokio::sync::oneshot;

// PDFDocument and its print operation live in PDFKit, which no other code links.
#[link(name = "PDFKit", kind = "framework")]
unsafe extern "C" {}

/// `kPDFPrintPageScaleDownToFit`: a page larger than the paper shrinks, a smaller one keeps its size.
const SCALE_DOWN_TO_FIT: isize = 2;

/// Whether the person printed (`Ok(false)` when they cancelled the panel).
pub type Printed = oneshot::Sender<Result<bool, String>>;

struct Ivars {
    done: RefCell<Option<Printed>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "KitionPdfDialogPrintDelegate"]
    #[ivars = Ivars]
    struct DialogDelegate;

    impl DialogDelegate {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _operation: *mut AnyObject, success: Bool, _context: *mut c_void) {
            if let Some(done) = self.ivars().done.borrow_mut().take() {
                let _ = done.send(Ok(success.as_bool()));
            }
        }
    }

    unsafe impl NSObjectProtocol for DialogDelegate {}
);

impl DialogDelegate {
    fn new(mtm: MainThreadMarker, done: Printed) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars {
            done: RefCell::new(Some(done)),
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// Opens the print panel for `bytes` (a PDF) on `webview`'s window; `done`
/// answers once the person printed or cancelled.
pub fn print(webview: &tauri::webview::PlatformWebview, bytes: &[u8], title: &str, done: Printed) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = done.send(Err("printing must run on the main thread".into()));
        return;
    };
    let window_ptr = webview.ns_window();
    if window_ptr.is_null() {
        let _ = done.send(Err("printing has no window".into()));
        return;
    }
    // SAFETY: Tauri hands out a live NSWindow pointer for the duration of
    // `with_webview`, and this runs on the main thread.
    let window = unsafe { &*(window_ptr as *const NSWindow) };
    let Some(class) = AnyClass::get(c"PDFDocument") else {
        let _ = done.send(Err("PDFKit is not available".into()));
        return;
    };

    let data = NSData::with_bytes(bytes);
    // SAFETY: `initWithData:` is PDFDocument's documented initializer; it
    // answers nil for bytes that are not a PDF.
    let document: Option<Retained<AnyObject>> = unsafe {
        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        msg_send![allocated, initWithData: &*data]
    };
    let Some(document) = document else {
        let _ = done.send(Err("the bytes are not a PDF".into()));
        return;
    };

    let info = NSPrintInfo::init(mtm.alloc());
    // SAFETY: PDFDocument's documented print operation for a print info, a
    // scaling mode (`PDFPrintScalingMode`, an NSInteger), and auto-rotation.
    let operation: Option<Retained<NSPrintOperation>> = unsafe {
        msg_send![&*document, printOperationForPrintInfo: &*info, scalingMode: SCALE_DOWN_TO_FIT, autoRotate: Bool::YES]
    };
    let Some(operation) = operation else {
        let _ = done.send(Err("the PDF cannot be printed".into()));
        return;
    };
    operation.setShowsPrintPanel(true);
    operation.setShowsProgressPanel(true);
    operation.setJobTitle(Some(&NSString::from_str(title)));

    let delegate = DialogDelegate::new(mtm, done);
    // SAFETY: the delegate implements the selector with the signature AppKit
    // calls, and the context pointer is unused.
    unsafe {
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            Some(&delegate),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
    }
    // AppKit does not retain print delegates; keep this one for the life of
    // the process. It holds nothing once the callback has fired.
    std::mem::forget(delegate);
}
