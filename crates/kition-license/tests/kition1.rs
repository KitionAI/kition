// Copied from kition-sdk crates/kition-license/tests/kition1.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! `KITION1` licences: signing round trip, every verification failure, renewals, and the status
//! table. Signed with obviously fake test seeds, never production keys. Built with the
//! `test-licences` feature (this crate's dev-dependency on itself); what a release build does with
//! a test licence is checked in the module's own unit tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use kition_license::kition1::{
    Customer, DEFAULT_GRACE_DAYS, Env, Error, Licence, MAX_TOKEN_LEN, Product, PublicKey, State, Term, Tier, Verified, assemble, decode, encode_payload,
    status, verify, verify_pinned,
};

const PROD_SEED: [u8; 32] = [11; 32];
const TEST_SEED: [u8; 32] = [12; 32];
const OTHER_SEED: [u8; 32] = [13; 32];
const NOW: u64 = 1_800_000_000;
const DAY: u64 = 86_400;

fn keys() -> Vec<PublicKey> {
    vec![
        PublicKey { kid: "prod-1", env: Env::Prod, key: SigningKey::from_bytes(&PROD_SEED).verifying_key().to_bytes() },
        PublicKey { kid: "test-1", env: Env::Test, key: SigningKey::from_bytes(&TEST_SEED).verifying_key().to_bytes() },
    ]
}

fn one(seats: u32) -> Licence {
    Licence {
        customer: Customer { email: "it@example.com".into(), org: "Example & Co".into() },
        employees: None,
        env: Env::Prod,
        expires_at: NOW + 365 * DAY,
        grace_days: DEFAULT_GRACE_DAYS,
        issued_at: NOW - DAY,
        kid: "prod-1".into(),
        lid: "lic_one_1".into(),
        product: Product::One,
        seats: Some(seats),
        starts_at: NOW - DAY,
        tier: None,
        v: 1,
    }
}

fn server(tier: Tier) -> Licence {
    Licence { employees: Some("9-200".into()), lid: "lic_srv_1".into(), product: Product::Server, seats: None, tier: Some(tier), ..one(9) }
}

fn sign_bytes(payload: &[u8], seed: &[u8; 32]) -> String {
    assemble(payload, &SigningKey::from_bytes(seed).sign(payload).to_bytes())
}

fn sign(licence: &Licence, seed: &[u8; 32]) -> String {
    sign_bytes(&encode_payload(licence), seed)
}

fn check(token: &str, product: Product) -> Result<Verified, Error> {
    verify(token, &keys(), product)
}

/// `licence`, signed with the production seed and verified: what `status` takes.
fn verified(licence: &Licence) -> Verified {
    check(&sign(licence, &PROD_SEED), licence.product).unwrap()
}

/// A licence from `starts_at` to `expires_at` (`issued_at` at the start).
fn dated(licence: Licence, starts_at: u64, expires_at: u64) -> Licence {
    Licence { starts_at, issued_at: starts_at, expires_at, ..licence }
}

#[test]
fn round_trip() {
    let licence = one(33);
    let token = sign(&licence, &PROD_SEED);
    assert!(token.starts_with("KITION1."));
    assert_eq!(*check(&token, Product::One).unwrap(), licence);
    assert_eq!(check(&format!("  {token}\n"), Product::One).unwrap().as_ref(), &licence);
    assert_eq!(*decode(&token).unwrap(), licence);
    let server = server(Tier::Business);
    assert_eq!(*check(&sign(&server, &PROD_SEED), Product::Server).unwrap(), server);
}

#[test]
fn the_compiled_keys_know_no_test_seed() {
    // PROD_KEYS and TEST_KEYS are empty until the owner makes the pairs: nothing verifies yet.
    assert_eq!(verify_pinned(&sign(&one(33), &PROD_SEED), Product::One).unwrap_err(), Error::UnknownKey);
}

#[test]
fn the_payload_is_canonical_json() {
    let json = String::from_utf8(encode_payload(&one(33))).unwrap();
    assert_eq!(
        json,
        r#"{"customer":{"email":"it@example.com","org":"Example & Co"},"env":"prod","expires_at":1831536000,"grace_days":14,"issued_at":1799913600,"kid":"prod-1","lid":"lic_one_1","product":"one","seats":33,"starts_at":1799913600,"v":1}"#
    );
    let json = String::from_utf8(encode_payload(&server(Tier::Free))).unwrap();
    assert!(json.contains(r#""employees":"9-200""#) && json.contains(r#""tier":"free""#) && !json.contains("seats"));
}

#[test]
fn the_signature_covers_the_exact_bytes_whatever_their_key_order() {
    // Console writes canonical JSON, but the verifier never re-serializes: any order it signed verifies.
    let payload = br#"{"v":1,"lid":"lic_x","kid":"prod-1","product":"one","customer":{"org":"X","email":"a@x.io"},"seats":10,"issued_at":1,"starts_at":1,"expires_at":2000000000,"env":"prod"}"#;
    let licence = check(&sign_bytes(payload, &PROD_SEED), Product::One).unwrap();
    assert_eq!(licence.grace_days, 14, "grace_days defaults to 14");
    assert_eq!(licence.seats, Some(10));
}

#[test]
fn tampering_breaks_the_signature() {
    let token = sign(&one(10), &PROD_SEED);
    let mut more = one(10);
    more.seats = Some(1_000);
    let (_, signature) = token.rsplit_once('.').unwrap();
    let forged = format!("KITION1.{}.{signature}", URL_SAFE_NO_PAD.encode(encode_payload(&more)));
    assert_eq!(check(&forged, Product::One), Err(Error::Signature));
    assert_eq!(check(&sign(&one(10), &OTHER_SEED), Product::One), Err(Error::Signature), "signed by a key not the kid's");
}

#[test]
fn malformed_tokens() {
    let token = sign(&one(10), &PROD_SEED);
    let without_prefix = token.strip_prefix("KITION1.").unwrap();
    for bad in ["", "KITION1.", "KITION1..", "not-a-licence", without_prefix, &format!("{token}.x"), &format!("KITION1.!!!.{}", "a")] {
        assert_eq!(check(bad, Product::One), Err(Error::Malformed), "{bad:?}");
    }
    let features = br#"{"customer":{"email":"a@x.io","org":"X"},"env":"prod","expires_at":2000000000,"features":["sso"],"issued_at":1,"kid":"prod-1","lid":"l","product":"one","seats":10,"starts_at":1,"v":1}"#;
    assert_eq!(check(&sign_bytes(features, &PROD_SEED), Product::One), Err(Error::Malformed), "no features field");
    let mut no_seats = one(10);
    no_seats.seats = None;
    assert_eq!(check(&sign(&no_seats, &PROD_SEED), Product::One), Err(Error::Malformed));
    let mut server_with_seats = server(Tier::Business);
    server_with_seats.seats = Some(10);
    assert_eq!(check(&sign(&server_with_seats, &PROD_SEED), Product::Server), Err(Error::Malformed));
    let mut backwards = one(10);
    backwards.starts_at = backwards.expires_at;
    assert_eq!(check(&sign(&backwards, &PROD_SEED), Product::One), Err(Error::Malformed));
}

#[test]
fn a_one_licence_covers_more_than_the_free_8() {
    assert_eq!(check(&sign(&one(8), &PROD_SEED), Product::One), Err(Error::Malformed));
    assert!(check(&sign(&one(9), &PROD_SEED), Product::One).is_ok());
}

#[test]
fn ids_are_short_and_plain() {
    for lid in ["", " lic_1", "lic 1", "lic_1\n", "lic.1", "lïc", &"a".repeat(65)] {
        let licence = Licence { lid: lid.into(), ..one(10) };
        assert_eq!(check(&sign(&licence, &PROD_SEED), Product::One), Err(Error::Malformed), "lid {lid:?}");
    }
    let padded = Licence { kid: " prod-1".into(), ..one(10) };
    assert_eq!(check(&sign(&padded, &PROD_SEED), Product::One), Err(Error::Malformed));
    let fine = Licence { lid: format!("Lic_{}-9", "a".repeat(58)), ..one(10) };
    assert!(check(&sign(&fine, &PROD_SEED), Product::One).is_ok());
}

#[test]
fn an_overlong_token_is_refused_before_decoding() {
    let token = sign(&Licence { customer: Customer { email: "a@x.io".into(), org: "X".repeat(MAX_TOKEN_LEN) }, ..one(10) }, &PROD_SEED);
    assert!(token.len() > MAX_TOKEN_LEN);
    assert_eq!(check(&token, Product::One), Err(Error::Malformed));
    assert_eq!(decode(&token).unwrap_err(), Error::Malformed);
}

#[test]
fn another_version() {
    let payload = br#"{"v":2,"anything":"new"}"#;
    assert_eq!(check(&sign_bytes(payload, &PROD_SEED), Product::One), Err(Error::Version));
}

#[test]
fn wrong_kid() {
    let mut licence = one(10);
    licence.kid = "prod-9".into();
    assert_eq!(check(&sign(&licence, &PROD_SEED), Product::One), Err(Error::UnknownKey));
}

#[test]
fn a_test_build_takes_test_licences() {
    let licence = Licence { env: Env::Test, kid: "test-1".into(), ..one(10) };
    assert_eq!(*check(&sign(&licence, &TEST_SEED), Product::One).unwrap(), licence);
}

#[test]
fn a_test_key_cannot_sign_a_production_licence() {
    let licence = Licence { kid: "test-1".into(), ..one(10) };
    assert_eq!(check(&sign(&licence, &TEST_SEED), Product::One), Err(Error::KeyEnv));
}

#[test]
fn a_licence_for_another_product() {
    assert_eq!(check(&sign(&server(Tier::Business), &PROD_SEED), Product::One), Err(Error::Product));
    assert_eq!(check(&sign(&one(10), &PROD_SEED), Product::Server), Err(Error::Product));
}

#[test]
fn an_expired_licence_still_verifies_so_grace_can_be_computed() {
    let licence = verified(&dated(one(10), NOW - 400 * DAY, NOW - 100 * DAY));
    assert_eq!(status(Product::One, &[licence], NOW, 3).state(), State::Expired);
}

#[test]
fn grace_boundaries() {
    let licence = [verified(&dated(one(20), NOW - 365 * DAY, NOW))];
    let at = |t: u64| status(Product::One, &licence, t, 5);
    assert_eq!(at(NOW - 1).term, Term::Expiring { days: 1 });
    assert_eq!(at(NOW).term, Term::Grace { days_left: 14 });
    assert_eq!(at(NOW + 13 * DAY).term, Term::Grace { days_left: 1 });
    assert_eq!(at(NOW + 14 * DAY - 1).term, Term::Grace { days_left: 1 });
    assert_eq!(at(NOW + 14 * DAY).term, Term::Expired);
    assert_eq!(at(NOW + 14 * DAY - 1).collab_limit(), None);
    assert_eq!(at(NOW + 14 * DAY).collab_limit(), Some(8));
    let short = [verified(&Licence { grace_days: 0, ..dated(one(20), NOW - 365 * DAY, NOW) })];
    assert_eq!(status(Product::One, &short, NOW, 5).term, Term::Expired);
}

#[test]
fn reminders() {
    let one = [verified(&dated(one(20), NOW - 365 * DAY, NOW))];
    let server = [verified(&dated(server(Tier::Business), NOW - 365 * DAY, NOW))];
    let one_at = |days: u64| status(Product::One, &one, NOW - days * DAY, 5);
    let server_at = |days: u64| status(Product::Server, &server, NOW - days * DAY, 5);
    assert_eq!(one_at(61).term, Term::Licensed);
    assert_eq!(one_at(61).reminder_stage(), None);
    assert_eq!((one_at(60).term, one_at(60).reminder_stage()), (Term::Expiring { days: 60 }, Some(60)));
    assert_eq!(one_at(31).reminder_stage(), Some(60));
    assert_eq!(one_at(30).reminder_stage(), Some(30));
    assert_eq!(one_at(8).reminder_stage(), Some(30));
    assert_eq!(one_at(7).reminder_stage(), Some(7));
    assert_eq!(one_at(1).reminder_stage(), Some(7));
    assert_eq!(server_at(60).term, Term::Licensed);
    assert_eq!(server_at(31).term, Term::Licensed);
    assert_eq!((server_at(30).term, server_at(30).reminder_stage()), (Term::Expiring { days: 30 }, Some(30)));
    assert_eq!(server_at(7).reminder_stage(), Some(30));
}

#[test]
fn a_renewal_starting_at_the_old_expiry_never_drops_to_free() {
    // The year ends at NOW; the renewal (more seats) starts there and is installed early.
    let old = verified(&dated(one(20), NOW - 365 * DAY, NOW));
    let renewal = verified(&Licence { lid: "lic_one_2".into(), ..dated(one(30), NOW, NOW + 365 * DAY) });
    let both = [old, renewal];
    let at = |t: u64| status(Product::One, &both, t, 25);
    // Before the old one ends: the old seats, and no reminder (the term runs on through the renewal).
    assert_eq!((at(NOW - 10 * DAY).term, at(NOW - 10 * DAY).limit), (Term::Licensed, Some(20)));
    assert_eq!(at(NOW - 10 * DAY).state(), State::OverSeats { used: 25, limit: 20 });
    // From the old expiry on: the renewal, never grace or free.
    for t in [NOW - 1, NOW, NOW + 1, NOW + 20 * DAY] {
        assert!(at(t).is_licensed(), "{t}");
        assert_eq!(at(t).collab_limit(), None, "{t}");
    }
    assert_eq!((at(NOW).term, at(NOW).limit), (Term::Licensed, Some(30)));
    assert_eq!(at(NOW + 305 * DAY).term, Term::Expiring { days: 60 });
}

#[test]
fn an_overlapping_renewal_takes_over_when_it_starts() {
    let old = verified(&dated(one(20), NOW - 300 * DAY, NOW + 65 * DAY));
    let renewal = verified(&Licence { lid: "lic_one_2".into(), ..dated(one(50), NOW - DAY, NOW + 365 * DAY) });
    // Order installed does not matter.
    for licences in [[old.clone(), renewal.clone()], [renewal.clone(), old.clone()]] {
        let now = status(Product::One, &licences, NOW, 40);
        assert_eq!((now.term, now.limit, now.state()), (Term::Licensed, Some(50), State::Licensed));
    }
    // Before the renewal starts, the old one applies (and is not expiring: the renewal follows).
    let before = status(Product::One, &[old, renewal], NOW - 2 * DAY, 10);
    assert_eq!((before.term, before.limit), (Term::Licensed, Some(20)));
}

#[test]
fn a_gap_between_licences() {
    // The old one ends at NOW; the next starts 30 days later, after the 14 days of grace.
    let old = verified(&dated(one(20), NOW - 365 * DAY, NOW));
    let late = verified(&Licence { lid: "lic_one_2".into(), ..dated(one(20), NOW + 30 * DAY, NOW + 395 * DAY) });
    let both = [old, late];
    let at = |t: u64| status(Product::One, &both, t, 5);
    assert_eq!(at(NOW - DAY).term, Term::Expiring { days: 1 });
    assert_eq!(at(NOW + DAY).term, Term::Grace { days_left: 13 });
    assert_eq!((at(NOW + 20 * DAY).term, at(NOW + 20 * DAY).collab_limit()), (Term::Expired, Some(8)));
    assert_eq!((at(NOW + 30 * DAY).term, at(NOW + 30 * DAY).collab_limit()), (Term::Licensed, None));
    // A renewal starting within the grace closes the gap: grace runs as licensed and leads into it.
    let old = verified(&dated(one(20), NOW - 365 * DAY, NOW));
    let in_grace = verified(&Licence { lid: "lic_one_3".into(), ..dated(one(20), NOW + 10 * DAY, NOW + 375 * DAY) });
    let closed = [old, in_grace];
    assert_eq!(status(Product::One, &closed, NOW + 5 * DAY, 5).term, Term::Licensed);
    assert_eq!(status(Product::One, &closed, NOW - 30 * DAY, 5).reminder_stage(), None);
}

#[test]
fn status_and_collab_limit_table() {
    let one33 = verified(&one(33));
    let one9 = verified(&one(9));
    let biz = verified(&server(Tier::Business));
    let free_key = verified(&server(Tier::Free));
    let future = verified(&Licence { starts_at: NOW + DAY, ..one(33) });
    let expired = verified(&dated(one(33), NOW - 400 * DAY, NOW - 15 * DAY));
    let expired_server = verified(&dated(server(Tier::Business), NOW - 400 * DAY, NOW - 15 * DAY));
    let grace = verified(&dated(one(33), NOW - 400 * DAY, NOW - DAY));

    let table: Vec<Row<'_>> = vec![
        (Product::One, &[], 0, State::Free, Some(8), Some(8)),
        (Product::One, &[], 8, State::Free, Some(8), Some(8)),
        (Product::One, &[], 9, State::OverSeats { used: 9, limit: 8 }, Some(8), Some(8)),
        (Product::One, std::slice::from_ref(&one33), 33, State::Licensed, Some(33), None),
        (Product::One, std::slice::from_ref(&one33), 34, State::OverSeats { used: 34, limit: 33 }, Some(33), None),
        (Product::One, std::slice::from_ref(&one9), 9, State::Licensed, Some(9), None),
        (Product::One, std::slice::from_ref(&future), 3, State::Free, Some(8), Some(8)),
        (Product::One, std::slice::from_ref(&grace), 40, State::Grace { days_left: 13 }, Some(33), None),
        (Product::One, std::slice::from_ref(&expired), 3, State::Expired, Some(8), Some(8)),
        (Product::One, std::slice::from_ref(&expired), 9, State::Expired, Some(8), Some(8)),
        (Product::One, std::slice::from_ref(&biz), 3, State::Free, Some(8), Some(8)),
        (Product::Server, &[], 8, State::Free, Some(8), Some(8)),
        (Product::Server, &[], 9, State::OverSeats { used: 9, limit: 8 }, Some(8), Some(8)),
        (Product::Server, std::slice::from_ref(&biz), 500, State::Licensed, None, None),
        (Product::Server, std::slice::from_ref(&free_key), 500, State::Licensed, None, None),
        (Product::Server, std::slice::from_ref(&expired_server), 3, State::Expired, Some(8), Some(8)),
    ];
    for (i, (product, licences, used, state, limit, collab)) in table.into_iter().enumerate() {
        let status = status(product, licences, NOW, used);
        assert_eq!(status.state(), state, "row {i}");
        assert_eq!(status.limit, limit, "row {i}");
        assert_eq!(status.collab_limit(), collab, "row {i}");
    }
}

/// (product, licences, used, state, limit, collab_limit)
type Row<'a> = (Product, &'a [Verified], u32, State, Option<u32>, Option<u32>);

#[test]
fn over_seats_ranks_below_grace_and_above_expiring() {
    let licence = [verified(&dated(one(10), NOW - 365 * DAY, NOW))];
    assert_eq!(status(Product::One, &licence, NOW - 5 * DAY, 11).state(), State::OverSeats { used: 11, limit: 10 });
    assert_eq!(status(Product::One, &licence, NOW - 5 * DAY, 11).term, Term::Expiring { days: 5 });
    assert_eq!(status(Product::One, &licence, NOW + DAY, 11).state(), State::Grace { days_left: 13 });
}
