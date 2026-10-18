//! Attachments held in the file as blobs (`kition_kitable::blobs`): storing a file's bytes, and
//! reading a blob back.
//!
//! The runtime's upload route takes a multipart file and calls [`put`]; a host without HTTP
//! (a kit's engine) calls `attachments.put` with the bytes in base64. `attachments.read`
//! answers the bytes in base64 too, where the runtime's route sends them as the response body.

use base64::Engine as _;
use kition_kitable::blobs::{self, BlobInfo};
use kition_kitable::{KitableError, KitableFile};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{ApiError, ApiResult};

fn refused(err: KitableError) -> ApiError {
    match err {
        KitableError::ReadOnly(reason) => ApiError::Conflict(reason),
        other => ApiError::bad_request(other.to_string()),
    }
}

/// The params of `attachments.put`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutRequest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub mime_type: String,
    /// The file's bytes, standard base64.
    #[serde(default)]
    pub data: String,
}

/// `POST /tables/{tableId}/attachments`: stores `bytes` in the file as a blob and answers the
/// attachment value an attachment cell holds for it (`url` is `kition-blob:<sha256>`).
pub fn put(
    file: &mut KitableFile,
    table_id: i64,
    bytes: &[u8],
    name: &str,
    mime: &str,
) -> ApiResult<Value> {
    file.get_table(table_id)
        .map_err(|_| ApiError::not_found("Table does not exist"))?;
    if bytes.is_empty() {
        return Err(ApiError::bad_request("Attachment content is empty"));
    }
    if bytes.len() > blobs::MAX_BLOB_BYTES {
        return Err(ApiError::bad_request(format!(
            "Attachment cannot exceed {}MB",
            blobs::MAX_BLOB_BYTES >> 20
        )));
    }
    let info: BlobInfo = file.put_blob(bytes, mime, name).map_err(refused)?;
    Ok(blobs::attachment_value(&info, name))
}

/// `attachments.put` with its params: the bytes in base64.
pub fn put_request(
    file: &mut KitableFile,
    table_id: i64,
    request: &PutRequest,
) -> ApiResult<Value> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.data.trim())
        .map_err(|_| ApiError::bad_request("Attachment data must be base64"))?;
    put(file, table_id, &bytes, &request.name, &request.mime_type)
}

/// `GET /blobs/{hash}`: the blob's description and its bytes in base64 (`data`).
pub fn read(file: &KitableFile, hash: &str) -> ApiResult<Value> {
    let blob = file
        .blob(hash.trim())
        .map_err(|err| ApiError::Unhandled(err.to_string()))?
        .ok_or_else(|| ApiError::not_found("Attachment does not exist"))?;
    Ok(json!({
        "hash": blob.info.hash,
        "name": blob.info.name,
        "mimeType": blob.info.mime,
        "sizeBytes": blob.info.size,
        "data": base64::engine::general_purpose::STANDARD.encode(&blob.bytes),
    }))
}
