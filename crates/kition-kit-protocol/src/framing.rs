//! Newline-delimited JSON framing (protocol section 2): one UTF-8 message per
//! line, at most [`MAX_MESSAGE_BYTES`] bytes.

use std::io::{self, BufRead};

use serde::Serialize;

pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("message exceeds {MAX_MESSAGE_BYTES} bytes")]
    TooLarge,
    #[error("message is not valid UTF-8")]
    InvalidUtf8,
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl FrameError {
    /// Whether the stream can continue with the next line after this error.
    pub fn is_recoverable(&self) -> bool {
        matches!(self, Self::TooLarge | Self::InvalidUtf8)
    }
}

/// Encodes a value as one frame, trailing newline included. Compact JSON
/// escapes control characters, so the frame never contains a raw newline.
pub fn encode<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Appends the bytes of the current line to `line`, reporting how many input
/// bytes to consume and whether the line ended.
fn take_line_chunk(available: &[u8], line: &mut Vec<u8>, too_large: &mut bool) -> (usize, bool) {
    let (chunk, consumed, ended) = match available.iter().position(|byte| *byte == b'\n') {
        Some(index) => (&available[..index], index + 1, true),
        None => (available, available.len(), false),
    };
    if !*too_large {
        if line.len() + chunk.len() > MAX_MESSAGE_BYTES {
            *too_large = true;
            line.clear();
        } else {
            line.extend_from_slice(chunk);
        }
    }
    (consumed, ended)
}

fn finish_line(line: &mut Vec<u8>, too_large: bool) -> Result<String, FrameError> {
    if too_large {
        return Err(FrameError::TooLarge);
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(std::mem::take(line)).map_err(|_| FrameError::InvalidUtf8)
}

/// Reads the next frame. Returns `Ok(None)` at a clean end of stream. An
/// oversized line is skipped entirely before `TooLarge` is returned, so the
/// caller can keep reading.
pub fn read_frame<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> Result<Option<String>, FrameError> {
    line.clear();
    let mut too_large = false;
    let mut started = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        };
        if available.is_empty() {
            if !started {
                return Ok(None);
            }
            break;
        }
        started = true;
        let (consumed, ended) = take_line_chunk(available, line, &mut too_large);
        reader.consume(consumed);
        if ended {
            break;
        }
    }
    finish_line(line, too_large).map(Some)
}

#[cfg(feature = "tokio")]
pub use async_io::{read_frame_async, write_frame_async};

#[cfg(feature = "tokio")]
mod async_io {
    use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

    use super::{FrameError, finish_line, take_line_chunk};

    /// The async counterpart of [`super::read_frame`].
    pub async fn read_frame_async<R: AsyncBufRead + Unpin>(
        reader: &mut R,
        line: &mut Vec<u8>,
    ) -> Result<Option<String>, FrameError> {
        line.clear();
        let mut too_large = false;
        let mut started = false;
        loop {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                if !started {
                    return Ok(None);
                }
                break;
            }
            started = true;
            let (consumed, ended) = take_line_chunk(available, line, &mut too_large);
            reader.consume(consumed);
            if ended {
                break;
            }
        }
        finish_line(line, too_large).map(Some)
    }

    /// Writes one encoded frame and flushes it.
    pub async fn write_frame_async<W: AsyncWrite + Unpin>(
        writer: &mut W,
        frame: &[u8],
    ) -> std::io::Result<()> {
        writer.write_all(frame).await?;
        writer.flush().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frames(input: &[u8]) -> Vec<Result<String, String>> {
        let mut reader = io::BufReader::with_capacity(4, Cursor::new(input.to_vec()));
        let mut line = Vec::new();
        let mut out = Vec::new();
        loop {
            match read_frame(&mut reader, &mut line) {
                Ok(Some(frame)) => out.push(Ok(frame)),
                Ok(None) => return out,
                Err(error) if error.is_recoverable() => out.push(Err(error.to_string())),
                Err(error) => panic!("{error}"),
            }
        }
    }

    #[test]
    fn splits_lines_across_buffer_boundaries() {
        assert_eq!(
            frames(b"{\"a\":1}\n{\"b\":2}\r\n{\"c\":3}"),
            vec![
                Ok("{\"a\":1}".to_owned()),
                Ok("{\"b\":2}".to_owned()),
                Ok("{\"c\":3}".to_owned())
            ]
        );
        assert!(frames(b"").is_empty());
    }

    #[test]
    fn skips_invalid_utf8_and_continues() {
        let result = frames(b"\xff\xfe\n{}\n");
        assert!(result[0].is_err());
        assert_eq!(result[1], Ok("{}".to_owned()));
    }

    #[test]
    fn encoded_frames_have_one_trailing_newline() {
        let bytes =
            encode(&serde_json::json!({"text": "a\nb"})).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
        assert_eq!(bytes.last(), Some(&b'\n'));
    }

    #[test]
    fn skips_oversized_lines_and_continues() {
        let mut input = vec![b'x'; MAX_MESSAGE_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = io::BufReader::new(Cursor::new(input));
        let mut line = Vec::new();
        assert!(matches!(
            read_frame(&mut reader, &mut line),
            Err(FrameError::TooLarge)
        ));
        assert_eq!(
            read_frame(&mut reader, &mut line).ok().flatten(),
            Some("{}".to_owned())
        );
    }
}
