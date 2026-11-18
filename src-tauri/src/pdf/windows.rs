//! Windows: WebView2's `PrintToPdf`.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    ICoreWebView2_7, ICoreWebView2Environment6,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{HSTRING, Interface};

use super::{Done, PdfOptions};

pub fn print(
    webview: &tauri::webview::PlatformWebview,
    options: &PdfOptions,
    output: &Path,
    done: Done,
) {
    let done = Arc::new(Mutex::new(Some(done)));
    let finish = {
        let done = done.clone();
        move |result: Result<(), String>| {
            if let Some(done) = done.lock().unwrap_or_else(PoisonError::into_inner).take() {
                let _ = done.send(result);
            }
        }
    };
    let callback_finish = finish.clone();
    let path = HSTRING::from(output.as_os_str());
    let started = (|| -> windows::core::Result<()> {
        // SAFETY: WebView2 COM calls on the UI thread that owns the controller.
        unsafe {
            let core = webview.controller().CoreWebView2()?;
            let core: ICoreWebView2_7 = core.cast()?;
            let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
            let settings = environment.CreatePrintSettings()?;
            settings.SetOrientation(if options.landscape {
                COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
            } else {
                COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
            })?;
            settings.SetPageWidth(options.width)?;
            settings.SetPageHeight(options.height)?;
            settings.SetMarginTop(options.margin)?;
            settings.SetMarginBottom(options.margin)?;
            settings.SetMarginLeft(options.margin)?;
            settings.SetMarginRight(options.margin)?;
            settings.SetScaleFactor(options.scale)?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                callback_finish(match result {
                    Ok(()) if ok => Ok(()),
                    Ok(()) => Err("PDF export failed".to_owned()),
                    Err(error) => Err(error.message()),
                });
                Ok(())
            }));
            core.PrintToPdf(&path, &settings, &handler)
        }
    })();
    if let Err(error) = started {
        finish(Err(error.message()));
    }
}
