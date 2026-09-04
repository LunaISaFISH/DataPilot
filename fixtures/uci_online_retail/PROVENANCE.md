# UCI Online Retail — provenance and licence

This is **real, public transaction data**, not a synthetic fixture.

- Source: Chen, D. (2015). *Online Retail* [Dataset]. UCI Machine Learning Repository.
  https://doi.org/10.24432/C5BW33 — archive file `online+retail.zip` (Excel workbook
  `Online Retail.xlsx`, 541,909 rows, 8 columns; UK-based online gift retailer,
  2010-12-01 to 2011-12-09).
- Licence: Creative Commons Attribution 4.0 International (CC BY 4.0). Attribution as above.
- Subset shipped here: every row whose `InvoiceDate` falls in **December 2010** — 42,481 rows,
  8 columns, file `online_retail_2010_12.csv` (3.5 MB, UTF-8). No rows were edited, added, or
  removed within the month; values are written as text the way the dataset is commonly
  distributed as CSV (dates as `M/D/YYYY H:MM`, integer-valued floats as integers, empty cells
  for missing values).
- `CustomerID` is a pseudonymous customer number assigned by the retailer; the dataset contains
  no names, addresses, e-mails, or phone numbers.

Real quality issues present in the December 2010 subset (measured while preparing the file):

| issue | count | how the contract treats it |
|---|---|---|
| lines without `CustomerID` | 15,631 | `required` → `MISS-CustomerID`, human quarantine only |
| negative `Quantity` (cancellations, invoices starting with `C`) | 798 | `min: 1` → `VAL-Quantity`, human chooses quarantine or flag |
| `UnitPrice` ≤ 0 (manual adjustments, samples) | 273 | `min: 0.01` → `VAL-UnitPrice` |
| exact duplicate lines | 500 | `DUP-EXACT`, policy-authorised exclusion |
| `Country` = `EIRE` (403 lines) | 403 | not in the allowed list → `SEM-Country`; the AI must recognise EIRE as Ireland |
| `Country` = `Channel Islands` (17 lines) | 17 | ambiguity registry → `AMB-Country`, quarantine only |
| `InvoiceDate` in `M/D/YYYY H:MM` | all 42,481 | `accept_formats` → `FMT-InvoiceDate`, policy-authorised standardisation to ISO |

Regenerate: download the archive from the DOI above, load the workbook, filter
`InvoiceDate.year == 2010 and month == 12`, write CSV with the formatting rules listed above.
