# Diary Exporter for MyFitnessPal

A Chrome extension that exports your **entire** MyFitnessPal food diary to a CSV file, covering any date range rather than just the last 12 months that MyFitnessPal's own export allows, with one row per food entry.

## How it works

MyFitnessPal's "Printable Diary" page is a front-end for an internal JSON endpoint (`POST /api/services/diary/report`) that accepts a `from`/`to` date range but caps each request at 365 days. The extension runs inside your logged-in MyFitnessPal tab and walks your chosen range in short windows (90 days by default), retries transient failures, splits a window in half if it keeps failing, flattens every food entry into a CSV row, and saves the result through Chrome's download manager.

Everything runs locally in your browser using your existing login. No data is sent anywhere other than to MyFitnessPal itself, and nothing is stored beyond the username and start date you last typed (kept in the popup's local storage for convenience).

## Install (unpacked, for personal use)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose this folder.
5. Pin the extension if you like.

## Use

1. Log in at [myfitnesspal.com](https://www.myfitnesspal.com/food/diary) and stay on any `www.myfitnesspal.com` page.
2. Click the extension icon. Your username and an estimated account-creation date are prefilled; adjust the dates if needed.
3. Click **Export food diary to CSV**. Progress shows in the popup; you can close the popup and reopen it later. The export keeps running in the tab.
4. When it finishes, `mfp_food_diary_<from>_to_<to>.csv` lands in your Downloads folder.

Don't navigate away from or reload the MyFitnessPal tab while an export is running.

### CSV columns

`date, meal_name, meal_position, brand_name, description, servings, serving_value, serving_unit, gram_weight, calories, carbohydrates, fat, protein, fiber, sugar, added_sugars, sodium, cholesterol, saturated_fat, trans_fat, monounsaturated_fat, polyunsaturated_fat, potassium, calcium, iron, vitamin_a, vitamin_c, vitamin_d, sugar_alcohols, food_id, entry_id, created_at, logged_at`

Nutrient values are for the logged serving (already multiplied by servings). `meal_name` is the meal slot as MyFitnessPal stores it (`1`–`6` on older accounts, or your custom meal names). Only days that have something logged are returned by MyFitnessPal, so a date missing from the CSV means nothing was logged that day.

## Caveats

- If the export fails immediately with "MyFitnessPal does not recognise the username", the Username field is wrong. It must match your profile name exactly (case does not matter).
- This relies on an undocumented MyFitnessPal endpoint. If MyFitnessPal changes it, the extension will stop working until updated.
- Automated access to your own data may still sit in a grey area under MyFitnessPal's Terms of Service. The extension makes the same requests the website itself makes, at a modest pace, but use your own judgement.
- This project is not affiliated with or endorsed by MyFitnessPal, Inc.

## License

MIT.
