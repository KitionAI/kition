//! macOS: WKWebView's print operation, saved to a file without any panels.

use std::cell::RefCell;
use std::ffi::c_void;
use std::path::Path;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSPaperOrientation, NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode,
    NSWindow,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_web_kit::WKWebView;

use super::{Done, PdfOptions};

const POINTS_PER_INCH: f64 = 72.0;

struct Ivars {
    done: RefCell<Option<Done>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "KitionPdfPrintDelegate"]
    #[ivars = Ivars]
    struct PrintDelegate;

    impl PrintDelegate {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _operation: *mut AnyObject, success: Bool, _context: *mut c_void) {
            if let Some(done) = self.ivars().done.borrow_mut().take() {
                let result = if success.as_bool() {
                    Ok(())
                } else {
                    Err("PDF export failed".to_owned())
                };
                let _ = done.send(result);
            }
        }
    }

    unsafe impl NSObjectProtocol for PrintDelegate {}
);

impl PrintDelegate {
    fn new(mtm: MainThreadMarker, done: Done) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars {
            done: RefCell::new(Some(done)),
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

pub fn print(
    webview: &tauri::webview::PlatformWebview,
    options: &PdfOptions,
    output: &Path,
    done: Done,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = done.send(Err("PDF export must run on the main thread".into()));
        return;
    };
    let (webview_ptr, window_ptr) = (webview.inner(), webview.ns_window());
    if webview_ptr.is_null() || window_ptr.is_null() {
        let _ = done.send(Err("PDF export has no web view".into()));
        return;
    }
    // SAFETY: Tauri hands out live WKWebView and NSWindow pointers for the
    // duration of `with_webview`, and this runs on the main thread.
    let (web_view, window) = unsafe {
        (
            &*(webview_ptr as *const WKWebView),
            &*(window_ptr as *const NSWindow),
        )
    };

    let (width, height) = if options.landscape {
        (options.height, options.width)
    } else {
        (options.width, options.height)
    };
    let paper = NSSize::new(width * POINTS_PER_INCH, height * POINTS_PER_INCH);
    let margin = options.margin * POINTS_PER_INCH;

    let info = NSPrintInfo::init(mtm.alloc());
    info.setOrientation(if options.landscape {
        NSPaperOrientation::Landscape
    } else {
        NSPaperOrientation::Portrait
    });
    info.setPaperSize(paper);
    info.setTopMargin(margin);
    info.setBottomMargin(margin);
    info.setLeftMargin(margin);
    info.setRightMargin(margin);
    info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    info.setScalingFactor(options.scale);
    // SAFETY: the statics are AppKit's documented print-info keys.
    unsafe {
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(&output.to_string_lossy()));
        let object: &AnyObject = &url;
        info.dictionary().insert(NSPrintJobSavingURL, object);
    }

    // SAFETY: the print info outlives the call, which copies it.
    let operation = unsafe { web_view.printOperationWithPrintInfo(&info) };
    operation.setShowsPrintPanel(false);
    operation.setShowsProgressPanel(false);
    if let Some(view) = operation.view() {
        // WKWebView paginates from the print view's frame, which starts empty.
        view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), paper));
    }

    let delegate = PrintDelegate::new(mtm, done);
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
