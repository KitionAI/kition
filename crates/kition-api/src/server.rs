//! Serving the API: as a standalone process, or on a dedicated thread inside
//! the desktop app.

use std::net::{Ipv4Addr, SocketAddr};

use anyhow::{Context, Result};
use kition_core::config::AppConfig;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::app;

/// Serves until Ctrl-C or SIGTERM. Used by the standalone binary.
pub async fn run(config: AppConfig) -> Result<()> {
    let (router, listener, tables) = prepare(config).await?;
    tracing::info!(addr = %listener.local_addr()?, "http server listening");
    let served = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("http server");
    tables.close_all();
    served
}

async fn prepare(
    config: AppConfig,
) -> Result<(axum::Router, TcpListener, kition_datadoc::TableDocuments)> {
    let port = u16::try_from(config.http_port).context("http port out of range")?;
    let deps = tokio::task::spawn_blocking(move || app::build_deps(config))
        .await
        .context("startup task failed")?
        .map_err(|err| anyhow::anyhow!("bootstrap app error: {err}"))?;
    let router = app::router(&deps);
    // Loopback only: the API has no authentication in the desktop app.
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .await
        .with_context(|| format!("listen on 127.0.0.1:{port}"))?;
    Ok((router, listener, deps.tables))
}

/// A runtime serving on its own thread and tokio runtime. Stopping it also
/// ends every background task it started.
pub struct RunningServer {
    pub addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RunningServer {
    /// Stops serving and waits for the runtime thread to finish.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts the runtime on a dedicated thread and returns once it is
/// listening, or with the startup error.
pub fn start(config: AppConfig) -> Result<RunningServer> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<SocketAddr>>();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let thread = std::thread::Builder::new()
        .name("kition-runtime".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("kition-runtime-worker")
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    let _ = ready_tx.send(Err(err.into()));
                    return;
                }
            };
            runtime.block_on(async move {
                let (router, listener, tables) = match prepare(config).await {
                    Ok(prepared) => prepared,
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                        return;
                    }
                };
                let addr = match listener.local_addr() {
                    Ok(addr) => addr,
                    Err(err) => {
                        let _ = ready_tx.send(Err(err.into()));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(addr));
                let served = axum::serve(listener, router)
                    .with_graceful_shutdown(async {
                        let _ = stop_rx.await;
                    })
                    .await;
                tables.close_all();
                if let Err(err) = served {
                    tracing::error!(error = %err, "http server stopped");
                }
            });
            // Dropping the runtime cancels schedulers and other background tasks.
            runtime.shutdown_timeout(std::time::Duration::from_secs(3));
        })
        .context("start runtime thread")?;
    let addr = ready_rx
        .recv()
        .context("runtime thread exited during startup")??;
    Ok(RunningServer {
        addr,
        stop: Some(stop_tx),
        thread: Some(thread),
    })
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
