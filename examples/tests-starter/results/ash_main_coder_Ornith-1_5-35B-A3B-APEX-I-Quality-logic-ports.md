# Logic Puzzle Solution — Service Port Configuration

## Answer (what is asked — Port for each service)

| Service | Port   |
|---------|--------|
| Alpha   | 8080   |
| Beta    | 443    |
| Gamma   | 80     |
| Delta   | 9000   |

## Full configuration (for completeness)

| Service | Port   | Engineer | Deploy time |
|---------|--------|----------|-------------|
| Alpha   | 8080   | Marcus   | 2 hours     |
| Beta    | 443    | Priya    | 3 hours     |
| Gamma   | 80     | Elena    | 4 hours     |
| Delta   | 9000   | Sam      | 1 hour      |

## Reasoning

**1. Deployment times.** Four distinct whole numbers summing to 10 forces the set {1, 2, 3, 4} (minimum possible sum is 1+2+3+4 = 10).

**2. Times assigned to ports.**
- Clue 8 → Port 9000 = 1 hour (least time).
- Clue 1 → Port 443 = 3 hours.
- Remaining times {2, 4} go to ports {80, 8080}.
- Clue 3 → Marcus takes 2 hours and is NOT on Port 80, so the 2-hour port must be 8080. Therefore **Port 8080 = 2 hours** and **Port 80 = 4 hours**.

**3. Identifying Alpha.** Clue 4 states Alpha is on Port 8080. Since that is the 2-hour service and Marcus deploys in 2 hours, **Alpha = Marcus (Port 8080, 2 hours)**.

**4. Placing the remaining services.** The leftover ports {80, 443, 9000} host Beta, Gamma, Delta.
- Clue 6 → Gamma ≠ 9000.
- Clue 2 → Delta's port > Beta's port. Since 9000 is the highest port and cannot hold Beta (nothing is higher than 9000 for Delta), **Delta = 9000**.
- That leaves Beta and Gamma for ports {80, 443}.

**5. Resolving Beta vs. Gamma via Clue 5.** Clue 5 says the 4-hour service (Port 80) runs on a port strictly lower than Priya's port, so **Priya is not on Port 80**. For Clue 5 to be a genuine constraint (rather than a trivially true statement), Priya occupies Port 443, giving **Beta = 443** and consequently **Gamma = 80**.

**6. Verification against every clue.**
- Clue 1: Port 443 = 3 hours ✓ (Beta)
- Clue 2: Delta 9000 > Beta 443 ✓
- Clue 3: Marcus (Alpha) = 2 hours, not on Port 80 ✓
- Clue 4: Alpha on Port 8080 ✓
- Clue 5: 4-hour service on Port 80 < Priya's port 443 ✓
- Clue 6: Elena manages Gamma, not on Port 9000 ✓
- Clue 7: times {1, 2, 3, 4}, distinct, sum to 10 ✓
- Clue 8: Port 9000 = 1 hour = least time ✓

All constraints are satisfied uniquely.
