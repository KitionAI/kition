pub mod commit;
pub mod migrate;
pub mod model;
pub mod ops;
pub mod options;
pub mod project;
pub mod read;
pub mod repair;
pub mod store;

use std::sync::{Arc, OnceLock};

use kition_kdm::Schema;

/// The `kit.table` document schema: the Table document on the KDM.
pub fn schema() -> Arc<Schema> {
    static SCHEMA: OnceLock<Arc<Schema>> = OnceLock::new();
    Arc::clone(SCHEMA.get_or_init(|| {
        match Schema::parse(include_str!("kit-table.schema.json")) {
            Ok(schema) => Arc::new(schema),
            // The schema is a constant of this crate; the test suite parses it.
            Err(err) => panic!("the embedded kit.table schema is invalid: {err}"),
        }
    }))
}
