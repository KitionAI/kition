//! The local transport (protocol section 2): a Unix domain socket on macOS
//! and Linux, a named pipe on Windows. The kit listens; clients connect.

use std::io;

use tokio::io::{AsyncRead, AsyncWrite};

pub type BoxReader = Box<dyn AsyncRead + Send + Unpin>;
pub type BoxWriter = Box<dyn AsyncWrite + Send + Unpin>;

pub use platform::{Listener, connect};

#[cfg(unix)]
mod platform {
    use std::io;
    use std::path::PathBuf;

    use tokio::net::{UnixListener, UnixStream};

    use super::{BoxReader, BoxWriter};

    /// Connects to a kit endpoint (a socket path).
    pub async fn connect(endpoint: &str) -> io::Result<(BoxReader, BoxWriter)> {
        let (reader, writer) = UnixStream::connect(endpoint).await?.into_split();
        Ok((Box::new(reader), Box::new(writer)))
    }

    /// A kit's listening endpoint.
    pub struct Listener {
        listener: UnixListener,
        path: PathBuf,
    }

    impl Listener {
        /// Binds the endpoint. The host already created the private parent
        /// directory; the socket file inherits its protection.
        pub fn bind(endpoint: &str) -> io::Result<Self> {
            Ok(Self {
                listener: UnixListener::bind(endpoint)?,
                path: PathBuf::from(endpoint),
            })
        }

        pub async fn accept(&mut self) -> io::Result<(BoxReader, BoxWriter)> {
            let (stream, _) = self.listener.accept().await?;
            let (reader, writer) = stream.into_split();
            Ok((Box::new(reader), Box::new(writer)))
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::io;
    use std::time::{Duration, Instant};

    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    use super::{BoxReader, BoxWriter};

    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PIPE_BUSY: i32 = 231;
    const CONNECT_RETRY: Duration = Duration::from_secs(2);

    /// Connects to a kit endpoint (a pipe name). Retries briefly while the
    /// kit is between pipe instances.
    pub async fn connect(endpoint: &str) -> io::Result<(BoxReader, BoxWriter)> {
        let deadline = Instant::now() + CONNECT_RETRY;
        let client = loop {
            match ClientOptions::new().open(endpoint) {
                Ok(client) => break client,
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(ERROR_PIPE_BUSY | ERROR_FILE_NOT_FOUND)
                    ) && Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(error) => return Err(error),
            }
        };
        let (reader, writer) = tokio::io::split(client);
        Ok((Box::new(reader), Box::new(writer)))
    }

    /// A kit's listening endpoint: always one unconnected pipe instance.
    pub struct Listener {
        name: String,
        next: NamedPipeServer,
    }

    impl Listener {
        pub fn bind(endpoint: &str) -> io::Result<Self> {
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(endpoint)?;
            Ok(Self {
                name: endpoint.to_owned(),
                next,
            })
        }

        pub async fn accept(&mut self) -> io::Result<(BoxReader, BoxWriter)> {
            self.next.connect().await?;
            let fresh = ServerOptions::new()
                .reject_remote_clients(true)
                .create(&self.name)?;
            let connected = std::mem::replace(&mut self.next, fresh);
            let (reader, writer) = tokio::io::split(connected);
            Ok((Box::new(reader), Box::new(writer)))
        }
    }
}

/// Whether an I/O error means the peer went away.
pub fn is_disconnect(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::UnexpectedEof
    )
}
