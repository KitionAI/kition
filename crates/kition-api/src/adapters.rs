//! Bridges between route groups (for example, sync services writing into
//! data document tables).

use kition_datadoc::DataDocState;
use kition_formsync::{TableField, TableRecord, TableWriter};
use kition_kdm::Origin;
use serde_json::{Map, Value};

/// Form sync writes submissions through the data document API.
pub struct DataDocTableWriter(pub DataDocState);

impl TableWriter for DataDocTableWriter {
    fn fields(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> Result<Vec<TableField>, String> {
        let (_, fields) = self
            .0
            .fetch_table_schema(user_id, document_id, table_id, Origin::system("formsync"))
            .map_err(|e| e.message.clone())?;
        Ok(fields
            .into_iter()
            .map(|f| TableField {
                id: f.id,
                name: f.name,
            })
            .collect())
    }

    fn records(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> Result<Vec<TableRecord>, String> {
        let records = self
            .0
            .fetch_table_records(user_id, document_id, table_id, Origin::system("formsync"))
            .map_err(|e| e.message.clone())?;
        Ok(records
            .into_iter()
            .map(|r| TableRecord {
                id: r.id,
                fields: r.fields,
            })
            .collect())
    }

    fn create(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
        values: &Map<String, Value>,
    ) -> Result<String, String> {
        self.0
            .create_record_for_workflow(
                user_id,
                document_id,
                table_id,
                values,
                Origin::system("formsync"),
            )
            .map_err(|e| e.message.clone())
    }
}
