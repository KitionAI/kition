//! Embedded kit surfaces: a desktop tab shows the kit's own native editor.
//!
//! Each surface is its own kit process in the `embedded` surface, editing one file. The kit's
//! borderless window is an overlay kept exactly over the tab's content area: the renderer reports
//! the area's rectangle in window coordinates, the desktop shell reports where the window is on
//! screen ([`crate::host`]), and a follower task sends `surface.setBounds` and
//! `surface.setVisible` as either changes. The overlay shows while its tab is active and either
//! Kition or the editor itself has focus; switching to another app hides it.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use kition_kit_protocol::launch::Surface;
use kition_kit_protocol::methods;
use kition_kit_protocol::types::*;
use serde::{Deserialize, Serialize};

use crate::host::{self, HostWindow};
use crate::manager::{
    Caller, DocumentView, KitDefinition, KitError, KitManager, RunningKit, Target,
};

/// Overlay windows need cross-process window placement, prototyped on macOS first.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

/// How long losing focus may wait for the kit's own window to report that it took focus.
const FOCUS_GRACE: Duration = Duration::from_millis(350);

/// A rectangle in logical pixels relative to the top-left of the window's web content.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Default)]
struct Placement {
    rect: Option<Rect>,
    /// The renderer wants the editor shown: its tab is active and nothing covers it.
    wanted: bool,
    sent_bounds: Option<Bounds>,
    sent_visible: Option<bool>,
}

pub(crate) struct SurfaceKit {
    pub(crate) id: u64,
    pub(crate) running: Arc<RunningKit>,
    pub(crate) path: String,
    placement: Mutex<Placement>,
    wake: tokio::sync::Notify,
}

impl SurfaceKit {
    fn placement(&self) -> std::sync::MutexGuard<'_, Placement> {
        self.placement
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceView {
    pub surface_id: u64,
    pub document: DocumentView,
}

fn normalize(path: &str) -> String {
    path.trim().trim_start_matches('/').to_owned()
}

fn screen_bounds(rect: Rect, host: &HostWindow) -> Bounds {
    Bounds {
        x: (host.x + rect.x).round(),
        y: (host.y + rect.y).round(),
        width: rect.width.max(1.0).round(),
        height: rect.height.max(1.0).round(),
    }
}

impl KitManager {
    /// The tab editor showing `path`, if one is open.
    pub(crate) async fn surface_for_path(&self, path: &str) -> Option<Arc<SurfaceKit>> {
        let path = normalize(path);
        self.inner
            .surfaces
            .lock()
            .await
            .values()
            .find(|surface| surface.path == path && !surface.running.host.is_closed())
            .cloned()
    }

    /// Opens `path` in an embedded editor over `rect`, or returns the editor already showing it.
    pub async fn open_surface(
        &self,
        path: &str,
        rect: Rect,
        visible: bool,
    ) -> Result<SurfaceView, KitError> {
        if !SUPPORTED {
            return Err(KitError::Unavailable(
                "embedding the editor is not available on this system yet".into(),
            ));
        }
        let host = host::current();
        if !host.known {
            return Err(KitError::Unavailable(
                "embedding the editor needs the Kition desktop app".into(),
            ));
        }
        let kit = self
            .kit_for_path(path)
            .ok_or_else(|| KitError::InvalidPath(format!("no kit opens `{path}`")))?;
        if !kit.embeds {
            return Err(KitError::Unavailable(format!(
                "{} has no embeddable editor",
                kit.name
            )));
        }
        if let Some(existing) = self.surface_for_path(path).await {
            {
                let mut placement = existing.placement();
                placement.rect = Some(rect);
                placement.wanted = visible;
            }
            existing.wake.notify_one();
            let (_, state) = self.surface_state(kit, &existing).await?;
            let document = self
                .view(
                    kit,
                    Target::Surface(existing.id),
                    &existing.running,
                    Caller::User,
                    state,
                )
                .await?;
            return Ok(SurfaceView {
                surface_id: existing.id,
                document,
            });
        }
        let uri = self.file_uri(path)?;
        let running = Arc::new(self.launch(kit, Surface::Embedded).await?);
        match self.attach_and_open(kit, &running, rect, &host, uri).await {
            Ok(state) => {
                let id = self.inner.next_surface.fetch_add(1, Ordering::Relaxed);
                let bounds = screen_bounds(rect, &host);
                let surface = Arc::new(SurfaceKit {
                    id,
                    running: Arc::clone(&running),
                    path: normalize(path),
                    placement: Mutex::new(Placement {
                        rect: Some(rect),
                        wanted: visible,
                        sent_bounds: Some(bounds),
                        sent_visible: Some(true),
                    }),
                    wake: tokio::sync::Notify::new(),
                });
                self.inner
                    .surfaces
                    .lock()
                    .await
                    .insert(id, Arc::clone(&surface));
                tokio::spawn(follow(Arc::clone(&surface)));
                let document = self
                    .view(kit, Target::Surface(id), &running, Caller::User, state)
                    .await?;
                surface.wake.notify_one();
                Ok(SurfaceView {
                    surface_id: id,
                    document,
                })
            }
            Err(error) => {
                running.stop().await;
                Err(error)
            }
        }
    }

    /// The editor draws, and therefore answers, only while shown: attach visible, then open.
    async fn attach_and_open(
        &self,
        kit: &'static KitDefinition,
        running: &RunningKit,
        rect: Rect,
        host: &HostWindow,
        uri: String,
    ) -> Result<DocumentState, KitError> {
        let attach = SurfaceAttachParams {
            mechanism: Mechanism::OverlayWindow,
            parent: Some(SurfaceParent {
                platform: ParentPlatform::Macos,
                handle: "0".into(),
            }),
            bounds: screen_bounds(rect, host),
            scale_factor: host.scale_factor.max(1.0),
            visible: true,
        };
        running
            .host
            .call::<methods::SurfaceAttach>(&attach)
            .await
            .map_err(|error| KitError::from_client(kit, error))?;
        running
            .host
            .call::<methods::DocumentOpen>(&DocumentOpenParams {
                uri,
                read_only: None,
                create: None,
            })
            .await
            .map_err(|error| KitError::from_client(kit, error))
    }

    async fn surface_state(
        &self,
        kit: &'static KitDefinition,
        surface: &SurfaceKit,
    ) -> Result<((), DocumentState), KitError> {
        let list = surface
            .running
            .host
            .call::<methods::DocumentList>(&Empty {})
            .await
            .map_err(|error| KitError::from_client(kit, error))?;
        let state = list.documents.into_iter().next().ok_or(KitError::Kit {
            reason: Some(kition_kit_protocol::ErrorReason::DocumentNotFound),
            message: "the editor has no document open".into(),
        })?;
        Ok(((), state))
    }

    /// Records where the tab's content area is and whether the editor should show.
    pub async fn update_surface(
        &self,
        id: u64,
        rect: Option<Rect>,
        visible: Option<bool>,
    ) -> Result<(), KitError> {
        let surface = self
            .inner
            .surfaces
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| KitError::Unavailable("the editor is closed".into()))?;
        {
            let mut placement = surface.placement();
            if let Some(rect) = rect {
                placement.rect = Some(rect);
            }
            if let Some(visible) = visible {
                placement.wanted = visible;
            }
        }
        surface.wake.notify_one();
        Ok(())
    }

    /// Stops the tab's editor. Unsaved changes in it are discarded.
    pub async fn close_surface(&self, id: u64) {
        let surface = self.inner.surfaces.lock().await.remove(&id);
        if let Some(surface) = surface {
            surface.running.stop().await;
        }
    }
}

/// Whether the overlay should show now, and whether only focus keeps it hidden.
fn desired(surface: &SurfaceKit, host: &HostWindow) -> (Option<Bounds>, bool, bool) {
    let placement = surface.placement();
    let bounds = placement.rect.map(|rect| screen_bounds(rect, host));
    let placeable = placement.wanted && bounds.is_some() && host.visible;
    let focused = host.focused || surface.running.focused.load(Ordering::SeqCst);
    (bounds, placeable && focused, placeable && !focused)
}

async fn apply(surface: &SurfaceKit) {
    let host = host::current();
    let (mut bounds, mut visible, focus_only) = desired(surface, &host);
    if focus_only && surface.placement().sent_visible == Some(true) {
        // Kition lost focus; the editor taking it reports so a moment later.
        tokio::time::sleep(FOCUS_GRACE).await;
        let host = host::current();
        (bounds, visible, _) = desired(surface, &host);
    }
    let host = host::current();
    let (send_bounds, send_visible) = {
        let placement = surface.placement();
        let send_bounds = bounds.filter(|bounds| visible && placement.sent_bounds != Some(*bounds));
        let send_visible = (placement.sent_visible != Some(visible)).then_some(visible);
        (send_bounds, send_visible)
    };
    if let Some(bounds) = send_bounds {
        let params = SurfaceSetBoundsParams {
            bounds,
            scale_factor: host.scale_factor.max(1.0),
        };
        if surface
            .running
            .host
            .call::<methods::SurfaceSetBounds>(&params)
            .await
            .is_ok()
        {
            surface.placement().sent_bounds = Some(bounds);
        }
    }
    if let Some(visible) = send_visible
        && surface
            .running
            .host
            .call::<methods::SurfaceSetVisible>(&SurfaceSetVisibleParams { visible })
            .await
            .is_ok()
    {
        surface.placement().sent_visible = Some(visible);
    }
}

/// Keeps one overlay in place until its kit stops.
async fn follow(surface: Arc<SurfaceKit>) {
    let mut host_rx = host::subscribe();
    loop {
        if surface.running.host.is_closed() {
            return;
        }
        apply(&surface).await;
        tokio::select! {
            changed = host_rx.changed() => {
                if changed.is_err() {
                    return;
                }
            }
            () = surface.wake.notified() => {}
            () = surface.running.focus_changed.notified() => {}
            () = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_bounds_are_screen_coordinates() {
        let host = HostWindow {
            x: 100.0,
            y: 40.0,
            scale_factor: 2.0,
            focused: true,
            known: true,
            visible: true,
        };
        let bounds = screen_bounds(
            Rect {
                x: 280.4,
                y: 44.0,
                width: 900.0,
                height: 0.0,
            },
            &host,
        );
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (380.0, 84.0, 900.0, 1.0)
        );
        assert_eq!(normalize("/art/a.psd"), "art/a.psd");
    }
}
