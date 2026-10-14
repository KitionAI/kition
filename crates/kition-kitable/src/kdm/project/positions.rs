//! Positions of list items in their relational rows, rewriting as few rows as possible.
//!
//! Legacy positions leave gaps (a delete renumbers nothing), and so do these: deletes renumber
//! nothing, and an insert or a move rewrites only the rows whose position must change.

/// The position of every item of a list, given each item's current position (`None`: a new row,
/// or one whose position does not count). The longest strictly increasing run of current
/// positions keeps them; every other item gets the first free positions after its predecessor,
/// and items after it move forward only where there is no room (a block of consecutive positions
/// right after an insert). Positions start at 1.
pub(crate) fn place(current: &[Option<i64>]) -> Vec<i64> {
    let mut kept = longest_increasing(current);
    let mut out = vec![0; current.len()];
    let mut previous = 0_i64;
    let mut index = 0;
    while index < current.len() {
        if let (true, Some(position)) = (flag(&kept, index), at(current, index)) {
            set(&mut out, index, position);
            previous = position;
            index += 1;
            continue;
        }
        let start = index;
        let mut end = index;
        while end < current.len() && !flag(&kept, end) {
            end += 1;
        }
        // Absorb the following kept items until the run fits before the next one.
        while end < current.len() {
            let needed = (end - start) as i64;
            let next = at(current, end).unwrap_or(i64::MAX);
            if next - previous > needed {
                break;
            }
            if let Some(slot) = kept.get_mut(end) {
                *slot = false;
            }
            end += 1;
            while end < current.len() && !flag(&kept, end) {
                end += 1;
            }
        }
        for slot in start..end {
            previous += 1;
            set(&mut out, slot, previous);
        }
        index = end;
    }
    out
}

fn at(items: &[Option<i64>], index: usize) -> Option<i64> {
    items
        .get(index)
        .copied()
        .flatten()
        .filter(|position| *position >= 1)
}

fn flag(flags: &[bool], index: usize) -> bool {
    flags.get(index).copied().unwrap_or(false)
}

fn set(out: &mut [i64], index: usize, value: i64) {
    if let Some(slot) = out.get_mut(index) {
        *slot = value;
    }
}

/// Marks the items of one longest strictly increasing subsequence of the known positions
/// (patience sorting, O(n log n)); ties go to the earliest such subsequence.
fn longest_increasing(current: &[Option<i64>]) -> Vec<bool> {
    // tails[k]: index of the smallest tail of an increasing run of length k + 1.
    let mut tails: Vec<usize> = Vec::new();
    let mut parent: Vec<Option<usize>> = vec![None; current.len()];
    for (index, position) in current.iter().enumerate() {
        let Some(position) = position.filter(|position| *position >= 1) else {
            continue;
        };
        let length = tails.partition_point(|tail| at(current, *tail).unwrap_or(0) < position);
        if let Some(slot) = parent.get_mut(index) {
            *slot = length
                .checked_sub(1)
                .and_then(|before| tails.get(before).copied());
        }
        if length == tails.len() {
            tails.push(index);
        } else if let Some(slot) = tails.get_mut(length) {
            *slot = index;
        }
    }
    let mut kept = vec![false; current.len()];
    let mut cursor = tails.last().copied();
    while let Some(index) = cursor {
        if let Some(slot) = kept.get_mut(index) {
            *slot = true;
        }
        cursor = parent.get(index).copied().flatten();
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::place;

    fn changed(current: &[Option<i64>]) -> usize {
        place(current)
            .iter()
            .zip(current)
            .filter(|(new, old)| Some(**new) != **old)
            .count()
    }

    fn increasing(positions: &[i64]) -> bool {
        positions.windows(2).all(|pair| pair[0] < pair[1])
            && positions.first().is_none_or(|first| *first >= 1)
    }

    #[test]
    fn dense_lists_stay_and_appends_follow() {
        assert_eq!(place(&[Some(1), Some(2), Some(3)]), vec![1, 2, 3]);
        assert_eq!(place(&[Some(1), Some(2), None]), vec![1, 2, 3]);
        assert_eq!(place(&[None, None]), vec![1, 2]);
        assert_eq!(place(&[]), Vec::<i64>::new());
    }

    #[test]
    fn deletes_leave_gaps() {
        assert_eq!(place(&[Some(2), Some(3), Some(7)]), vec![2, 3, 7]);
    }

    #[test]
    fn a_move_rewrites_one_row() {
        // The first of five moved last.
        let current = [Some(2), Some(3), Some(4), Some(5), Some(1)];
        assert_eq!(place(&current), vec![2, 3, 4, 5, 6]);
        assert_eq!(changed(&current), 1);
        // The last moved first: no room before 1, so the block shifts.
        let current = [Some(5), Some(1), Some(2), Some(3), Some(4)];
        assert_eq!(place(&current), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn inserts_use_gaps_before_shifting() {
        // A gap at the top takes an insert there.
        assert_eq!(place(&[None, Some(2), Some(3)]), vec![1, 2, 3]);
        // Without one, the consecutive block after the insert moves forward, and no further.
        assert_eq!(place(&[None, Some(1), Some(2), Some(5)]), vec![1, 2, 3, 5]);
        assert_eq!(
            place(&[Some(1), None, Some(2), Some(3), Some(9)]),
            vec![1, 2, 3, 4, 9]
        );
        // Into a large gap.
        assert_eq!(place(&[Some(1), None, None, Some(10)]), vec![1, 2, 3, 10]);
    }

    #[test]
    fn ties_and_invalid_positions_are_resolved() {
        let placed = place(&[Some(1), Some(1), Some(0), Some(-3), Some(2)]);
        assert!(increasing(&placed), "{placed:?}");
    }

    #[test]
    fn random_lists_stay_increasing() {
        let mut seed = 7_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..500 {
            let len = (next() % 30) as usize;
            let current: Vec<Option<i64>> = (0..len)
                .map(|_| (next() % 4 != 0).then(|| (next() % 40) as i64))
                .collect();
            let placed = place(&current);
            assert_eq!(placed.len(), current.len());
            assert!(increasing(&placed), "{current:?} -> {placed:?}");
        }
    }
}
