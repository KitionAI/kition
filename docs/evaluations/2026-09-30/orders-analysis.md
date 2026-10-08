# Orders Analysis

Source imported: `source://pilot-fixtures/orders.csv`

## Import verification

Created native data table: `Pilot Orders.kitable` / table `Pilot Orders`.

- Records saved: 6 of 6
- Original fields preserved: 6 of 6
  - `order_id`
  - `team`
  - `quantity`
  - `unit_price`
  - `currency`
  - `status`
- Order IDs saved as text, preserving leading zeros (`001` through `006`).
- Missing quantity for order `006` saved as `unknown`.

## Revenue calculations

Revenue is calculated as `quantity × unit_price` where quantity is known.

| Metric | Amount |
|---|---:|
| Paid revenue | $65.00 |
| Known total revenue | $85.00 |

## Totals by team

| Team | Paid revenue | Known total revenue | Incomplete rows |
|---|---:|---:|---:|
| Alpha | $25.00 | $45.00 | 0 |
| Beta | $40.00 | $40.00 | 0 |
| Gamma | $0.00 | $0.00 | 0 |
| Delta | $0.00 | Unknown | 1 |

## Incomplete rows

| order_id | team | quantity | unit_price | currency | status | Issue |
|---|---|---:|---:|---|---|---|
| 006 | Delta | unknown | 9.00 | USD | pending | Missing quantity; row excluded from known total revenue. |

## Row-level computed revenue

| order_id | team | status | quantity | unit_price | computed revenue |
|---|---|---|---:|---:|---:|
| 001 | Alpha | paid | 2 | $12.50 | $25.00 |
| 002 | Beta | paid | 3 | $10.00 | $30.00 |
| 003 | Alpha | pending | 1 | $20.00 | $20.00 |
| 004 | Gamma | paid | 0 | $15.00 | $0.00 |
| 005 | Beta | paid | 4 | $2.50 | $10.00 |
| 006 | Delta | pending | unknown | $9.00 | Unknown |
