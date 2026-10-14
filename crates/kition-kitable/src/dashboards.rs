//! Dashboards: unlike tables, not relational (see `kdm::project`'s module doc) — read and
//! written straight through the KDM document. A dashboard's id is a KDM object id (a string),
//! not a small integer like a table's.

use kition_kdm::ObjectId;
use serde_json::{Map, Value};

use crate::kdm::commit::{any_object, table_id_of};
use crate::kdm::model;
use crate::kdm::options::{self, IdKind};
use crate::kdm::read::ModelView;
use crate::{KitableError, KitableFile, Result};

/// One dashboard, in the relational API's shape: `config`'s table reference (when present) is
/// a local `source_table_id`, not a KDM object id (see
/// [`options::options_to_kdm`]/[`options::options_from_kdm`]). `widgets` are keyed by widget id.
#[derive(Debug, Clone, PartialEq)]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    pub config: Value,
    pub widgets: Map<String, Value>,
}

impl KitableFile {
    /// The base's dashboards in order.
    pub fn list_dashboards(&self) -> Result<Vec<Dashboard>> {
        let view = ModelView::new(&self.replica);
        view.dashboards()?
            .into_iter()
            .map(|data| {
                Ok(Dashboard {
                    id: data.id.to_string(),
                    name: data.name,
                    config: options::options_from_kdm(&data.config, |object| {
                        table_id_of(&self.conn, object).ok()
                    }),
                    widgets: data.widgets,
                })
            })
            .collect()
    }

    fn get_dashboard(&self, id: &str) -> Result<Dashboard> {
        self.list_dashboards()?
            .into_iter()
            .find(|dashboard| dashboard.id == id)
            .ok_or(KitableError::NotFound)
    }

    /// Creates or updates a dashboard; `id: None` creates one with a new id, matching
    /// [`model::upsert_dashboard`]. `config` and widget values are in the relational API's
    /// shape (see [`Dashboard`]).
    pub fn upsert_dashboard(
        &mut self,
        id: Option<&str>,
        name: &str,
        config: Value,
        widgets: &Map<String, Value>,
    ) -> Result<Dashboard> {
        self.writable()?;
        let base = self.require_base()?;
        let kdm_config = options::options_to_kdm(&config, |kind, local| match kind {
            IdKind::Table => any_object(&self.conn, "kition_tables", local)
                .ok()
                .flatten(),
            IdKind::Field => any_object(&self.conn, "kition_fields", local)
                .ok()
                .flatten(),
        })?;
        let object_id = id.map(ObjectId::from_string);
        let (dashboard_id, _) = self.commit(|tx| {
            model::upsert_dashboard(tx, &base, object_id.as_ref(), name, kdm_config, widgets)
        })?;
        self.get_dashboard(dashboard_id.as_str())
    }

    pub fn delete_dashboard(&mut self, id: &str) -> Result<()> {
        self.writable()?;
        let base = self.require_base()?;
        let object_id = ObjectId::from_string(id);
        self.commit(|tx| model::delete_dashboard(tx, &base, &object_id))?;
        Ok(())
    }
}
