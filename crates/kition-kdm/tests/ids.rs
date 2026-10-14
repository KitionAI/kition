// Copied from kition-sdk crates/kition-kdm/tests/ids.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::collections::BTreeSet;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, OriginKind};

#[test]
fn object_ids_are_unique_uuid_v7_strings() {
    let ids: BTreeSet<ObjectId> = (0..1000).map(|_| ObjectId::new()).collect();
    assert_eq!(ids.len(), 1000);
    let first = ids.iter().next().map(ObjectId::to_string).unwrap_or_default();
    assert_eq!(first.len(), 36);
    assert_eq!(&first[14..15], "7");
}

#[test]
fn doc_ids_round_trip_through_text() {
    let id = DocId::new();
    assert_eq!(DocId::parse(&id.to_string()).unwrap(), id);
    assert!(DocId::parse("not a uuid").is_err());
}

#[test]
fn actors_never_use_the_reserved_value() {
    assert!(ActorId::from_u64(u64::MAX).is_err());
    assert_eq!(ActorId::from_u64(7).unwrap().get(), 7);
    for _ in 0..100 {
        assert!(ActorId::random().get() < 1 << 63);
    }
}

#[test]
fn origin_kinds_have_stable_names() {
    for kind in [OriginKind::Person, OriginKind::Agent, OriginKind::Extension, OriginKind::Import, OriginKind::System] {
        assert_eq!(OriginKind::parse(kind.as_str()), Some(kind));
    }
    assert_eq!(Origin::person("user:1").encode(), r#"["person","user:1",null]"#);
}
