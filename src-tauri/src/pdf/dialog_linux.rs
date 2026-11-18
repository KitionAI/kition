//! Linux: prints a PDF a kit hands over (KitFiles `files/print`) with GTK's
//! print dialog. The PDF itself goes to the printer (`GtkPrintJob` with the
//! file as its source; CUPS takes PDF), so nothing is re-rendered and text
//! stays vector. GTK's Unix print dialog is in `libgtk-3` but not in the gtk
//! crates, so its few functions are declared here.

use std::ffi::{CString, c_char, c_int, c_void};
use std::path::PathBuf;

use gtk::glib::translate::{FromGlibPtrNone, IntoGlib, ToGlibPtr};
use gtk::prelude::*;
use tokio::sync::oneshot;

/// Whether the person printed (`Ok(false)` when they cancelled the dialog).
pub type Printed = oneshot::Sender<Result<bool, String>>;

/// `GTK_PRINT_CAPABILITY_GENERATE_PDF`: the job is a PDF already.
const GENERATE_PDF: c_int = 1 << 5;
/// `GTK_RESPONSE_OK`.
const RESPONSE_OK: c_int = -5;

unsafe extern "C" {
    fn gtk_print_unix_dialog_new(
        title: *const c_char,
        parent: *mut gtk::ffi::GtkWindow,
    ) -> *mut gtk::ffi::GtkWidget;
    fn gtk_print_unix_dialog_set_manual_capabilities(
        dialog: *mut gtk::ffi::GtkWidget,
        capabilities: c_int,
    );
    fn gtk_print_unix_dialog_get_selected_printer(dialog: *mut gtk::ffi::GtkWidget) -> *mut c_void;
    fn gtk_print_unix_dialog_get_settings(
        dialog: *mut gtk::ffi::GtkWidget,
    ) -> *mut gtk::ffi::GtkPrintSettings;
    fn gtk_print_unix_dialog_get_page_setup(
        dialog: *mut gtk::ffi::GtkWidget,
    ) -> *mut gtk::ffi::GtkPageSetup;
    fn gtk_printer_accepts_pdf(printer: *mut c_void) -> gtk::glib::ffi::gboolean;
    fn gtk_print_job_new(
        title: *const c_char,
        printer: *mut c_void,
        settings: *mut gtk::ffi::GtkPrintSettings,
        page_setup: *mut gtk::ffi::GtkPageSetup,
    ) -> *mut c_void;
    fn gtk_print_job_set_source_file(
        job: *mut c_void,
        filename: *const c_char,
        error: *mut *mut gtk::glib::ffi::GError,
    ) -> gtk::glib::ffi::gboolean;
    fn gtk_print_job_send(
        job: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, *mut c_void, *const gtk::glib::ffi::GError),
        user_data: *mut c_void,
        dnotify: Option<unsafe extern "C" fn(*mut c_void)>,
    );
}

/// What the job's callback finishes: the answer and the spooled file to remove.
struct Sending {
    done: Printed,
    file: PathBuf,
}

unsafe extern "C" fn job_sent(
    job: *mut c_void,
    user_data: *mut c_void,
    error: *const gtk::glib::ffi::GError,
) {
    // SAFETY: `user_data` is the `Sending` boxed in `print`, handed over exactly once, and the
    // job's reference from `gtk_print_job_new` is released here, once it has been sent.
    let sending = unsafe { Box::from_raw(user_data.cast::<Sending>()) };
    unsafe { gtk::glib::gobject_ffi::g_object_unref(job.cast()) };
    let _ = std::fs::remove_file(&sending.file);
    let result = if error.is_null() {
        Ok(true)
    } else {
        // SAFETY: GTK passes a valid GError for the call's duration.
        let message = unsafe { std::ffi::CStr::from_ptr((*error).message) };
        Err(message.to_string_lossy().into_owned())
    };
    let _ = sending.done.send(result);
}

/// Opens the print dialog for `bytes` (a PDF) over `parent` (the main
/// thread); `done` answers once the job reached the printer, or the person
/// cancelled.
pub fn print(parent: Option<gtk::Window>, bytes: &[u8], title: &str, done: Printed) {
    let file = std::env::temp_dir().join(format!(
        "kition-print-{}.pdf",
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(error) = std::fs::write(&file, bytes) {
        let _ = done.send(Err(format!(
            "the PDF could not be spooled: {}",
            error.kind()
        )));
        return;
    }
    let (Ok(c_title), Ok(c_file)) = (
        CString::new(title.replace('\0', "")),
        CString::new(file.to_string_lossy().as_bytes()),
    ) else {
        let _ = std::fs::remove_file(&file);
        let _ = done.send(Err("the print job has no valid name".into()));
        return;
    };

    // SAFETY: GTK calls on the main thread (`with_webview`), with live
    // pointers; the dialog is a GtkDialog, destroyed before returning.
    unsafe {
        let parent_ptr: *mut gtk::ffi::GtkWindow = parent
            .as_ref()
            .map_or(std::ptr::null_mut(), |window| window.to_glib_none().0);
        let raw = gtk_print_unix_dialog_new(c_title.as_ptr(), parent_ptr);
        gtk_print_unix_dialog_set_manual_capabilities(raw, GENERATE_PDF);
        let dialog = gtk::Dialog::from_glib_none(raw.cast::<gtk::ffi::GtkDialog>());
        let response: c_int = dialog.run().into_glib();
        if response != RESPONSE_OK {
            dialog.destroy();
            let _ = std::fs::remove_file(&file);
            let _ = done.send(Ok(false));
            return;
        }
        let printer = gtk_print_unix_dialog_get_selected_printer(raw);
        if printer.is_null() || gtk_printer_accepts_pdf(printer) == 0 {
            dialog.destroy();
            let _ = std::fs::remove_file(&file);
            let _ = done.send(Err("the chosen printer does not take PDF".into()));
            return;
        }
        let settings = gtk_print_unix_dialog_get_settings(raw);
        let page_setup = gtk_print_unix_dialog_get_page_setup(raw);
        let job = gtk_print_job_new(c_title.as_ptr(), printer, settings, page_setup);
        // `get_settings` answers a new reference; the job keeps its own.
        gtk::glib::gobject_ffi::g_object_unref(settings.cast());
        dialog.destroy();
        let mut error: *mut gtk::glib::ffi::GError = std::ptr::null_mut();
        if gtk_print_job_set_source_file(job, c_file.as_ptr(), &mut error) == 0 {
            let message = if error.is_null() {
                "the PDF could not be printed".to_owned()
            } else {
                let message = std::ffi::CStr::from_ptr((*error).message)
                    .to_string_lossy()
                    .into_owned();
                gtk::glib::ffi::g_error_free(error);
                message
            };
            gtk::glib::gobject_ffi::g_object_unref(job.cast());
            let _ = std::fs::remove_file(&file);
            let _ = done.send(Err(message));
            return;
        }
        let sending = Box::into_raw(Box::new(Sending { done, file }));
        // `job_sent` releases the job once it has been sent.
        gtk_print_job_send(job, job_sent, sending.cast(), None);
    }
}
