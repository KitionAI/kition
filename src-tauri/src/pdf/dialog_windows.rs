//! Windows: prints a PDF a kit hands over (KitFiles `files/print`) with the
//! system's print dialog (`PrintDlgEx`). Windows' own PDF renderer
//! (`Windows.Data.Pdf`) draws each page at up to 300 dpi, and GDI puts it on
//! the printer, fitted to the printable area. WebView2's printing is not used:
//! it prints PDF documents unreliably (WebView2Feedback #5499, #5744).
//!
//! [`page_count`] and [`print`] run on a worker thread (Windows Runtime calls
//! block there); [`ask`] runs on the window's thread, which owns the dialog.

use std::ffi::c_void;

use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::{Buffer, InMemoryRandomAccessStream, InputStreamOptions};
use windows::Win32::Foundation::{GlobalFree, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteDC, GetDeviceCaps, HALFTONE, HDC,
    HORZRES, LOGPIXELSX, LOGPIXELSY, SRCCOPY, SetStretchBltMode, StretchDIBits, VERTRES,
};
use windows::Win32::Storage::Xps::{AbortDoc, DOCINFOW, EndDoc, EndPage, StartDocW, StartPage};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::Win32::UI::Controls::Dialogs::{
    PD_NOCURRENTPAGE, PD_NOSELECTION, PD_PAGENUMS, PD_RESULT_PRINT, PD_RETURNDC,
    PD_USEDEVMODECOPIESANDCOLLATE, PRINTDLGEXW, PRINTPAGERANGE, PrintDlgExW, START_PAGE_GENERAL,
};
use windows::core::{HSTRING, PCWSTR};

/// The finest a page is rendered for the printer: sharp text without page
/// bitmaps of hundreds of megabytes.
const MAX_DPI: f64 = 300.0;
/// Page ranges the dialog may answer.
const MAX_RANGES: usize = 32;
/// Windows.Data.Pdf measures pages in device-independent pixels.
const DIPS_PER_INCH: f64 = 96.0;

/// What the person chose: the printer (its device context, as a number so it
/// crosses threads), the pages (1-based, inclusive), and the copies the
/// driver does not make itself.
pub struct Choice {
    hdc: isize,
    pages: Vec<(u32, u32)>,
    copies: u32,
}

fn message(error: &windows::core::Error) -> String {
    error.message()
}

/// Initializes COM for the Windows Runtime on this worker thread (harmless when it already is).
fn runtime() {
    // SAFETY: COM initialization on the calling thread; a second call answers S_FALSE.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

fn load(bytes: &[u8]) -> windows::core::Result<PdfDocument> {
    let stream = InMemoryRandomAccessStream::new()?;
    let buffer = CryptographicBuffer::CreateFromByteArray(bytes)?;
    stream.WriteAsync(&buffer)?.join()?;
    stream.Seek(0)?;
    PdfDocument::LoadFromStreamAsync(&stream)?.join()
}

/// The PDF's page count (a worker thread): the dialog's page range.
pub fn page_count(bytes: &[u8]) -> Result<u32, String> {
    runtime();
    let document =
        load(bytes).map_err(|_| "the bytes are not a PDF Windows can print".to_owned())?;
    document.PageCount().map_err(|error| message(&error))
}

/// Shows the print dialog over `owner` (the window's thread). `None` when the
/// person cancelled.
pub fn ask(owner: isize, pages: u32) -> Result<Option<Choice>, String> {
    let mut ranges = [PRINTPAGERANGE {
        nFromPage: 1,
        nToPage: pages.max(1),
    }; MAX_RANGES];
    let mut dialog = PRINTDLGEXW {
        lStructSize: std::mem::size_of::<PRINTDLGEXW>() as u32,
        hwndOwner: HWND(owner as *mut c_void),
        Flags: PD_RETURNDC | PD_USEDEVMODECOPIESANDCOLLATE | PD_NOSELECTION | PD_NOCURRENTPAGE,
        nPageRanges: 1,
        nMaxPageRanges: MAX_RANGES as u32,
        lpPageRanges: ranges.as_mut_ptr(),
        nMinPage: 1,
        nMaxPage: pages.max(1),
        nCopies: 1,
        nStartPage: START_PAGE_GENERAL,
        ..Default::default()
    };
    // SAFETY: the structure and its page ranges outlive the modal call.
    let shown = unsafe { PrintDlgExW(&mut dialog) };
    // SAFETY: the dialog's device-mode and device-name memory is ours to free.
    unsafe {
        free(dialog.hDevMode);
        free(dialog.hDevNames);
    }
    shown.map_err(|error| message(&error))?;
    if dialog.dwResultAction != PD_RESULT_PRINT {
        if !dialog.hDC.is_invalid() {
            // SAFETY: the dialog made this device context for us.
            let _ = unsafe { DeleteDC(dialog.hDC) };
        }
        return Ok(None);
    }
    if dialog.hDC.is_invalid() {
        return Err("the print dialog chose no printer".into());
    }
    let chosen = if dialog.Flags.contains(PD_PAGENUMS) {
        ranges
            .iter()
            .take(dialog.nPageRanges as usize)
            .map(|range| (range.nFromPage.max(1), range.nToPage.min(pages)))
            .filter(|(from, to)| from <= to)
            .collect()
    } else {
        vec![(1, pages)]
    };
    Ok(Some(Choice {
        hdc: dialog.hDC.0 as isize,
        pages: chosen,
        copies: dialog.nCopies.max(1),
    }))
}

unsafe fn free(memory: HGLOBAL) {
    if !memory.is_invalid() {
        // SAFETY: memory the print dialog allocated for the caller.
        let _ = unsafe { GlobalFree(Some(memory)) };
    }
}

/// Prints the chosen pages of `bytes` on the chosen printer (a worker thread),
/// then releases the printer's device context.
pub fn print(choice: Choice, bytes: &[u8], title: &str) -> Result<(), String> {
    runtime();
    let hdc = HDC(choice.hdc as *mut c_void);
    let result = print_pages(hdc, &choice, bytes, title);
    // SAFETY: the dialog made this device context; nothing uses it after this.
    let _ = unsafe { DeleteDC(hdc) };
    result
}

fn print_pages(hdc: HDC, choice: &Choice, bytes: &[u8], title: &str) -> Result<(), String> {
    let document = load(bytes).map_err(|error| message(&error))?;
    let name = HSTRING::from(title);
    let info = DOCINFOW {
        cbSize: std::mem::size_of::<DOCINFOW>() as i32,
        lpszDocName: PCWSTR(name.as_ptr()),
        ..Default::default()
    };
    // SAFETY: GDI printing on a device context this thread owns now.
    if unsafe { StartDocW(hdc, &info) } <= 0 {
        return Err("the printer did not start the job".into());
    }
    let printed = (|| {
        for _ in 0..choice.copies {
            for &(from, to) in &choice.pages {
                for page in from..=to {
                    print_page(hdc, &document, page - 1)?;
                }
            }
        }
        Ok(())
    })();
    // SAFETY: ends (or abandons) the document started above.
    unsafe {
        if printed.is_ok() {
            EndDoc(hdc);
        } else {
            AbortDoc(hdc);
        }
    }
    printed
}

fn print_page(hdc: HDC, document: &PdfDocument, index: u32) -> Result<(), String> {
    let page = document.GetPage(index).map_err(|error| message(&error))?;
    let size = page.Size().map_err(|error| message(&error))?;
    // SAFETY: device capabilities of the printer's device context.
    let (printable_w, printable_h, dpi_x, dpi_y) = unsafe {
        (
            GetDeviceCaps(Some(hdc), HORZRES),
            GetDeviceCaps(Some(hdc), VERTRES),
            GetDeviceCaps(Some(hdc), LOGPIXELSX),
            GetDeviceCaps(Some(hdc), LOGPIXELSY),
        )
    };
    if printable_w <= 0 || printable_h <= 0 || dpi_x <= 0 || dpi_y <= 0 {
        return Err("the printer reported no printable area".into());
    }
    // The page at its own size, shrunk to fit the printable area, centred.
    let (inches_w, inches_h) = (
        f64::from(size.Width) / DIPS_PER_INCH,
        f64::from(size.Height) / DIPS_PER_INCH,
    );
    let fit = (f64::from(printable_w) / (inches_w * f64::from(dpi_x)))
        .min(f64::from(printable_h) / (inches_h * f64::from(dpi_y)))
        .min(1.0);
    let (dest_w, dest_h) = (
        (inches_w * f64::from(dpi_x) * fit).round() as i32,
        (inches_h * f64::from(dpi_y) * fit).round() as i32,
    );
    let (dest_x, dest_y) = ((printable_w - dest_w) / 2, (printable_h - dest_h) / 2);
    let render_dpi = f64::from(dpi_x.min(dpi_y)).min(MAX_DPI) * fit;
    let (render_w, render_h) = (
        ((inches_w * render_dpi).round() as u32).max(1),
        ((inches_h * render_dpi).round() as u32).max(1),
    );

    let rgba = render(&page, render_w, render_h)?;
    // GDI takes bottom-up BGR(A) rows unless the height is negative: top-down BGRA here.
    let mut bgra = rgba.into_raw();
    for pixel in bgra.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: render_w as i32,
        biHeight: -(render_h as i32),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let bitmap = BITMAPINFO {
        bmiHeader: header,
        ..Default::default()
    };
    // SAFETY: GDI calls on the printer's device context with a bitmap that
    // outlives them.
    unsafe {
        if StartPage(hdc) <= 0 {
            return Err("the printer did not start a page".into());
        }
        SetStretchBltMode(hdc, HALFTONE);
        let drawn = StretchDIBits(
            hdc,
            dest_x,
            dest_y,
            dest_w,
            dest_h,
            0,
            0,
            render_w as i32,
            render_h as i32,
            Some(bgra.as_ptr().cast()),
            &bitmap,
            DIB_RGB_COLORS,
            SRCCOPY,
        );
        if EndPage(hdc) <= 0 || drawn == 0 {
            return Err("the printer did not take a page".into());
        }
    }
    Ok(())
}

/// One page as RGBA, `width` × `height`, on white (Windows.Data.Pdf answers PNG).
fn render(
    page: &windows::Data::Pdf::PdfPage,
    width: u32,
    height: u32,
) -> Result<image::RgbaImage, String> {
    let rendered = (|| -> windows::core::Result<Vec<u8>> {
        let options = PdfPageRenderOptions::new()?;
        options.SetDestinationWidth(width)?;
        options.SetDestinationHeight(height)?;
        let stream = InMemoryRandomAccessStream::new()?;
        page.RenderWithOptionsToStreamAsync(&stream, &options)?
            .join()?;
        let size = u32::try_from(stream.Size()?).unwrap_or(u32::MAX);
        stream.Seek(0)?;
        let buffer = Buffer::Create(size)?;
        let read = stream
            .ReadAsync(&buffer, size, InputStreamOptions::None)?
            .join()?;
        let mut bytes = windows::core::Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(&read, &mut bytes)?;
        Ok(bytes.to_vec())
    })()
    .map_err(|error| message(&error))?;
    let decoded = image::load_from_memory(&rendered)
        .map_err(|error| format!("a page did not render: {error}"))?
        .to_rgba8();
    // Transparent areas print as paper.
    let mut on_white = image::RgbaImage::from_pixel(
        decoded.width(),
        decoded.height(),
        image::Rgba([255, 255, 255, 255]),
    );
    image::imageops::overlay(&mut on_white, &decoded, 0, 0);
    Ok(on_white)
}
