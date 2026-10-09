//! A list that keeps the legacy distinction between "never set" (`null`)
//! and "set to empty" (`[]`) when it round-trips through JSON.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoVec<T>(pub Option<Vec<T>>);

impl<T> Default for GoVec<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<T> GoVec<T> {
    pub fn set(items: Vec<T>) -> Self {
        Self(Some(items))
    }

    pub fn as_slice(&self) -> &[T] {
        self.0.as_deref().unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.as_slice().is_empty()
    }

    pub fn len(&self) -> usize {
        self.as_slice().len()
    }

    pub fn iter(&self) -> std::slice::Iter<'_, T> {
        self.as_slice().iter()
    }

    pub fn push(&mut self, item: T) {
        self.0.get_or_insert_with(Vec::new).push(item);
    }
}

impl<T> std::ops::Deref for GoVec<T> {
    type Target = [T];

    fn deref(&self) -> &[T] {
        self.as_slice()
    }
}

impl<T> From<Vec<T>> for GoVec<T> {
    fn from(items: Vec<T>) -> Self {
        Self(Some(items))
    }
}

impl<'a, T> IntoIterator for &'a GoVec<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl<T: Serialize> Serialize for GoVec<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for GoVec<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self(Option::<Vec<T>>::deserialize(deserializer)?))
    }
}
