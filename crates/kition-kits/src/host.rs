//! Where the host window is on screen. The desktop shell runs the runtime in its own process and
//! updates this value as the window moves, resizes, or changes focus; embedded kit surfaces
//! follow it, because an overlay window is placed in screen coordinates.

use std::sync::OnceLock;

use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HostWindow {
    /// Top-left of the window's web content in screen logical points (top-left origin).
    pub x: f64,
    pub y: f64,
    pub scale_factor: f64,
    pub focused: bool,
    /// Whether a desktop shell reported a window at all. Browser runs leave it `false`.
    pub known: bool,
    /// Minimized, hidden, or on another Space: kit surfaces hide with it.
    pub visible: bool,
}

fn channel() -> &'static watch::Sender<HostWindow> {
    static HOST: OnceLock<watch::Sender<HostWindow>> = OnceLock::new();
    HOST.get_or_init(|| watch::Sender::new(HostWindow::default()))
}

/// Records a change to the host window. Called by the desktop shell.
pub fn update(change: impl FnOnce(&mut HostWindow)) {
    channel().send_if_modified(|window| {
        let before = *window;
        change(window);
        window.known = true;
        *window != before
    });
}

pub fn current() -> HostWindow {
    *channel().borrow()
}

pub fn subscribe() -> watch::Receiver<HostWindow> {
    channel().subscribe()
}
