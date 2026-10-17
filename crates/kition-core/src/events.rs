//! In-process domain events. Delivery is best effort: a subscriber that
//! falls behind loses the oldest events, like the legacy bounded queues.

use serde_json::{Map, Value};
use tokio::sync::broadcast;

use crate::Millis;

#[derive(Debug, Clone, PartialEq)]
pub enum DomainEvent {
    RecordCreated(RecordCreated),
    RecordUpdated(RecordUpdated),
    /// A data document's `table/changed` payload
    /// (`contracts/runtime/table-changed.schema.json`), already built as JSON by the producer
    /// (`kition-datadoc`) so this crate does not need to depend on the table document format to
    /// carry it. `kition-kits` forwards it verbatim to the kit bridge stream as a `table/changed`
    /// notification.
    TableChanged(Value),
    /// A `.kitable` file's KDM replica moved to a new version after a local transaction (any
    /// origin but `import`): the `table/replica-changed` payload
    /// (`contracts/runtime/data-documents-replica.schema.json`), built by `kition-datadoc`.
    /// `kition-kits` forwards it verbatim to the kit bridge stream, so a co-editing relay knows
    /// there are changes to export.
    TableReplicaChanged(Value),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordCreated {
    pub user_id: i64,
    pub document_id: String,
    pub table_id: String,
    pub record_id: String,
    pub fields: Map<String, Value>,
    pub created_at: Millis,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordUpdated {
    pub user_id: i64,
    pub document_id: String,
    pub table_id: String,
    pub record_id: String,
    pub fields: Map<String, Value>,
    /// Values before the update, when the source could provide them.
    pub previous: Option<Map<String, Value>>,
    pub updated_at: Millis,
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<DomainEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(256)
    }
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(1));
        Self { sender }
    }

    pub fn publish(&self, event: DomainEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DomainEvent> {
        self.sender.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delivers_to_every_subscriber() {
        let bus = EventBus::new(4);
        let mut first = bus.subscribe();
        let mut second = bus.subscribe();
        let event = DomainEvent::RecordCreated(RecordCreated {
            user_id: 1,
            document_id: "1".into(),
            table_id: "2".into(),
            record_id: "3".into(),
            fields: Map::new(),
            created_at: 0,
        });
        bus.publish(event.clone());
        assert_eq!(first.recv().await.ok(), Some(event.clone()));
        assert_eq!(second.recv().await.ok(), Some(event));
    }

    #[test]
    fn publishing_without_subscribers_is_harmless() {
        EventBus::default().publish(DomainEvent::RecordUpdated(RecordUpdated {
            user_id: 1,
            document_id: String::new(),
            table_id: String::new(),
            record_id: String::new(),
            fields: Map::new(),
            previous: None,
            updated_at: 0,
        }));
    }

    #[tokio::test]
    async fn table_changed_carries_its_json_payload_to_every_subscriber() {
        let bus = EventBus::new(4);
        let mut subscriber = bus.subscribe();
        let payload = serde_json::json!({
            "documentId": "1",
            "origin": "person:session:abc",
            "tables": [],
            "schema": [],
            "views": [],
            "recordsUpserted": [[1, "r1"]],
            "recordsDeleted": [],
            "recordsReordered": [],
            "dashboards": false,
            "documentPath": "Notes/a.kitable",
        });
        bus.publish(DomainEvent::TableChanged(payload.clone()));
        assert_eq!(
            subscriber.recv().await.ok(),
            Some(DomainEvent::TableChanged(payload))
        );
    }
}
