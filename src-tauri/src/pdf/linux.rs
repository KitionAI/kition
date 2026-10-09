//! Linux: WebKitGTK's print operation with GTK's print-to-file backend.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use gtk::{PageOrientation, PageSetup, PaperSize, PrintSettings, Unit};
use webkit2gtk::PrintOperationExt;

use super::{Done, PdfOptions};

pub fn print(
    webview: &tauri::webview::PlatformWebview,
    options: &PdfOptions,
    output: &Path,
    done: Done,
) {
    let done = Arc::new(Mutex::new(Some(done)));
    let finish = move |done: &Arc<Mutex<Option<Done>>>, result: Result<(), String>| {
        if let Some(done) = done.lock().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = done.send(result);
        }
    };
    let Ok(uri) = url::Url::from_file_path(output) else {
        finish(&done, Err("PDF export path is invalid".into()));
        return;
    };

    let settings = PrintSettings::new();
    settings.set_printer("Print to File");
    settings.set("output-file-format", Some("pdf"));
    settings.set("output-uri", Some(uri.as_str()));
    settings.set_scale(options.scale * 100.0);

    let setup = PageSetup::new();
    setup.set_paper_size(&PaperSize::new_custom(
        "kition-export",
        "Kition export",
        options.width,
        options.height,
        Unit::Inch,
    ));
    setup.set_orientation(if options.landscape {
        PageOrientation::Landscape
    } else {
        PageOrientation::Portrait
    });
    setup.set_top_margin(options.margin, Unit::Inch);
    setup.set_bottom_margin(options.margin, Unit::Inch);
    setup.set_left_margin(options.margin, Unit::Inch);
    setup.set_right_margin(options.margin, Unit::Inch);

    let operation = webkit2gtk::PrintOperation::new(&webview.inner());
    operation.set_print_settings(&settings);
    operation.set_page_setup(&setup);
    let failed = done.clone();
    operation.connect_failed(move |_, error| finish(&failed, Err(error.to_string())));
    let finished = done.clone();
    operation.connect_finished(move |_| finish(&finished, Ok(())));
    operation.print();
}
