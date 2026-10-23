//! In-process domain events. Delivery is best effort: a subscriber that
//! falls behind loses the oldest events, like the legacy bounded queues.

use serde_json::{Map, Value};
use tokio::sync::broadcast;

use crate::Millis;

#[derive(Debug, Clone, PartialEq)]
pub enum DomainEvent {
    RecordCreated(RecordCreated),
    RecordUpdated(RecordUpdated),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordCreated {
    pub user_id: i64,
    /// The table file's workspace-relative path.
    pub document_path: String,
    pub table_id: String,
    pub record_id: String,
    pub fields: Map<String, Value>,
    pub created_at: Millis,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordUpdated {
    pub user_id: i64,
    /// The table file's workspace-relative path.
    pub document_path: String,
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
            document_path: "Leads.ktable".into(),
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
            document_path: String::new(),
            table_id: String::new(),
            record_id: String::new(),
            fields: Map::new(),
            previous: None,
            updated_at: 0,
        }));
    }
}
