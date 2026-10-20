# How Zuma Dispatch prices a delivery

Use this only to **explain** prices. Never compute a price yourself: always call
`quote_delivery`, which applies these rules on the server (rate card version 2026-10-A).

| Package | Vehicle | Covers the first 3 km | Each extra km |
|---|---|---|---|
| Small (backpack, up to 5 kg) | Bike | ₦1,500 | ₦150 |
| Medium (shoebox to carton, up to 10 kg) | Bike | ₦2,000 | ₦180 |
| Large (up to 25 kg) | Car | ₦3,500 | ₦300 |

- Distance is the **road distance** between pickup and drop-off, rounded up to whole kilometres.
- The total is rounded up to the nearest ₦50.
- If the route service is down, the distance is estimated from a straight line (x1.4) and the
  quote says "estimated".
- Trips longer than 60 km by road are not offered.
- Quotes are valid for 30 minutes. After that, quote again; the price may change.
- There are no surcharges, discounts or tips.

Worked examples (the server's unit tests check these):
- Small, 2 km: ₦1,500.
- Small, 5.1 km (Jabi Lake Mall to Wuse Market): 3 extra km, ₦1,500 + ₦450 = **₦1,950**.
- Medium, 12.4 km: 10 extra km, ₦2,000 + ₦1,800 = **₦3,800**.
- Large, 22 km: 19 extra km, ₦3,500 + ₦5,700 = **₦9,200**.
