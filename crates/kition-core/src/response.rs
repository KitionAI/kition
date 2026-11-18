//! The JSON envelope every runtime endpoint returns.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub code: i64,
    pub message: String,
    pub data: Value,
}

impl Envelope {
    pub fn success(data: impl Into<Value>) -> Self {
        Self {
            code: 200,
            message: "success".to_owned(),
            data: data.into(),
        }
    }

    pub fn failure(code: i64, message: impl Into<String>, data: impl Into<Value>) -> Self {
        Self {
            code,
            message: message.into(),
            data: data.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_matches_legacy_shape() {
        let json = serde_json::to_value(Envelope::success("healthy")).unwrap_or_default();
        assert_eq!(
            json,
            serde_json::json!({"code": 200, "message": "success", "data": "healthy"})
        );
    }
}
