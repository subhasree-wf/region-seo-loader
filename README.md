# region-seo-loader

A helper for loading a city landing page file into MongoDB.

Someone hands you `lisbon-en.js`. Today you open it, look for empty descriptions, build four image blocks by hand, paste links into 24 places, work out which section each image belongs to, set the collection name, then run `mongosh`. This script does all of that, asks you only for the four image links and the database, and saves a finished file you can hand to an admin later.

One file, no dependencies, no config. Nothing is saved to disk except the output file, so there are no credentials sitting anywhere.

## Setup

Check you have the two tools:

```bash
node --version     # v18 or higher
mongosh --version  # any version
```

Then set up a folder like this:

```
your-folder/
  region-seo-loader.js
  images.txt        <- optional, the script offers to create it
  input/            <- drop the files you are given here
  output/           <- created for you
```

You only need to make `input/`. The script creates `output/` the first time it runs, and `images.txt` when you first ask it to remember a set of links.

## Every time you get a new city file

**1. Drop the file in `input/`.** Keep the name as `city-lang.js`, for example `lisbon-en.js`, `milan-it.js`.

**2. Have the four Prismic image links ready.** Full links, like:

```
https://images.prismic.io/wunderflatscontent/Q-BIw5ygzTsr1ypG_LisbonImage1.jpg
```

**3. Run it with just the name.** No path, no `.js` needed:

```bash
node region-seo-loader.js lisbon-en
```

**4. Paste the image links.** The script reads the file first, so it can tell you where each image is going before it asks. If the links are already saved in `images.txt` (see below) it uses those and asks nothing:

```
2. Images
  -     no images.txt yet, so you will be asked
  Each prompt names where the image lands.

  IMAGE_1  ->  h2 #1  "Tips for Finding an Apartment in Lisbon"
  Prismic URL: _

  IMAGE_2  ->  h2 #2  "Living in Lisbon"
  Prismic URL: _

  IMAGE_3  ->  h2 #2 > h3 #2  "Sightseeing in Lisbon"
  Prismic URL: _

  IMAGE_4  ->  h2 #3  "Frequently Asked Questions About Renting in Lisbon"
  Prismic URL: _
```

`IMAGE_1` takes the file named "Lisbon Image 1", and so on. The heading is shown so you can see it is going somewhere sensible before you paste.

Afterwards it offers to remember them:

```
  Save these URLs to images.txt for next time? [y/N]: _
```

Say yes and this city never asks again.

**5. Check the write summary.** Before saving, it tells you exactly what will happen in either case:

```
3. Write statement
  OK    generated prismicId: 7QVq7tj0828AlBkh  (the file had null)
  -     only used if this run creates the document. An existing one is never touched.
  -     document:      slug=lisbon  lang=en
  -     one updateOne with upsert:
  -       $set          every run       h2s
  -       $setOnInsert  creation only   lang, metaDescription, metaTitle, prismicId, slug, title
```

**6. Pick the database.** Press Enter for local, or paste another connection string. The script checks the database first and tells you which fields the write will carry, then asks you to confirm.

**7. Done.** It runs `mongosh`, reads the document back, and prints the `_id`, the `prismicId` and how many sections and images it found.

The finished file is now at `output/lisbon-en.js`, ready to hand to an admin.

### Try it first without touching a database

```bash
node region-seo-loader.js lisbon-en --dry-run
```

Everything up to the database, saves `output/lisbon-en.js`, then stops.

## Doing every city at once

```bash
node region-seo-loader.js --all
```

Takes every `.js` in `input/`, in alphabetical order. Naming a single city still works exactly as before, `--all` just replaces the name.

The order is deliberate: **everything is prepared first, and nothing touches the database until you have seen all of it.**

1. Lists the files it found
2. Works through each one with its own banner, asking only for image links it cannot find in `images.txt`
3. Prints a summary of every output file it wrote
4. Asks for the connection string **once**, not once per city
5. Checks each city against the database and tells you which will be created and which updated
6. Asks you to confirm **once**, naming the count: `Write all 5 cities to localhost:27017/wunderflats-dev? [y/N]`
7. Runs them, then prints a final table

```
7. Summary
  OK    brussels-en      _id=64f0aa11 prismicId=Zz1 h2s=3  h2s with an image=3
  OK    lisbon-en        _id=64f0aa11 prismicId=Zz1 h2s=3  h2s with an image=3
  WARN  madrid-en        mongosh exit 3
  OK    milan-en         _id=64f0aa11 prismicId=Zz1 h2s=3  h2s with an image=3
  OK    zurich-en        _id=64f0aa11 prismicId=Zz1 h2s=3  h2s with an image=3

Finished with 1 problem(s): madrid-en
```

**One city failing does not stop the others.** Each is a separate write, so the rest still go through and the summary names what went wrong. The script exits with a non-zero code if anything failed, so it is safe to use in a larger script.

Files starting with `.` or `_` are skipped, so `_wip-berlin-de.js` stays out of a batch run.

With every city in `images.txt`, `--all --dry-run` needs no input at all. Add `--yes` to write to local without the confirmation. Staging still stops and makes you type the host name, once, for the whole batch.

`--all` cannot be combined with a city name or with `--out`, and says so rather than guessing.

## The output file

This is the part that matters for handing work over. `output/lisbon-en.js` is self-contained and decides for itself what to write when it runs.

It is one `updateOne` with `upsert: true`, with two payloads:

```js
var KEY = { slug: 'lisbon', lang: 'en' };

// Replaced on every run.
var WRITE_ALWAYS = { h2s: [ ... ] };

// Only used if this run creates the document. Never overwritten afterwards.
var WRITE_ON_CREATE = {
  lang: 'en',
  metaDescription: '',
  metaTitle: '',
  prismicId: '2hTjPc2MSe3D1zhW',
  slug: 'lisbon',
  title: 'Furnished Apartments in Lisbon'
};

db.getCollection(COLLECTION).updateOne(
  KEY,
  { $set: WRITE_ALWAYS, $setOnInsert: WRITE_ON_CREATE },
  { upsert: true }
);
```

`$setOnInsert` is the whole trick. MongoDB applies it only when the upsert actually creates a document, and ignores it completely when one is already there. So:

| Situation | What is written |
| --- | --- |
| No document for that slug and lang | Everything. `h2s` from `$set`, plus `slug`, `lang`, `title`, `metaTitle`, `metaDescription` and `prismicId` from `$setOnInsert` |
| Document already exists | `h2s` only. Everything in `$setOnInsert` is ignored, so those fields keep exactly what the live document has |

No read, no branching, no window where two runs could race each other. One command either way.

**Every value in `WRITE_ON_CREATE` is copied verbatim from your input file.** The only exception is `prismicId`, which is generated when the input has none or has it set to `null`. If `metaTitle` and `metaDescription` come out empty, that is because they are empty in the input, not because the script dropped them.

**`_id` is dropped.** If the input file pins one, for example `_id: ObjectId('6a879...')`, the script strips it and lets MongoDB assign the ID. A hard coded `_id` would give the same document a different identity in each environment only by luck, and MongoDB will not let `$set` modify `_id` on an existing document anyway. You will see `dropped _id from the write, MongoDB assigns it` when this happens.

The admin runs it the same way you always have:

```bash
mongosh "mongodb://<their-connection>" output/lisbon-en.js
```

It prints what it did:

```
{ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
Updated {"slug":"lisbon","lang":"en"}. Written: h2s.
Left as it was: lang, metaDescription, metaTitle, prismicId, slug, title.
```

Running it twice is safe.

**One thing this means.** On an existing document the whole `h2s` array is replaced, images included. If someone has edited text or swapped an image directly in the database inside `h2s`, that edit is overwritten. Everything outside `h2s` is safe.

## Saving the image links: `images.txt`

Pasting four URLs into prompts works, but it is easier to check them when they sit in a file you can read. `images.txt` is that file. One file for every city, so it never adds to the pile in `input/`.

It lives next to `region-seo-loader.js`, and the format is just what your colleague already sends you:

```
Lisbon-en:

https://images.prismic.io/wunderflatscontent/Q-BIw5ygzTsr1ypG_LisbonImage1.jpg
https://images.prismic.io/wunderflatscontent/EMGP_CiU1AGD7jAS_LisbonImage2.jpg
https://images.prismic.io/wunderflatscontent/cREAbyFRLNDLzldn_LisbonImage3.jpg
https://images.prismic.io/wunderflatscontent/jVrOauOOOX1dM9g__LisbonImage4.jpg

Milan-en:

https://images.prismic.io/wunderflatscontent/ZW1RDvlepBVyFyQe_MilanImage1.jpg
https://images.prismic.io/wunderflatscontent/2j3iYDIDEjQNqOtM_MilanImage2.jpg
https://images.prismic.io/wunderflatscontent/jepOk1cZ60Lshrxp_MilanImage3.jpg
https://images.prismic.io/wunderflatscontent/uPH2JEQcFhuTIyrV_MilanImage4.jpg
```

Paste the whole message in and it works. The rules are forgiving:

- A heading is any line ending in a colon. It matches the input file name without `.js`, ignoring case, so `Lisbon-en:` finds `input/lisbon-en.js`
- The URLs under a heading are taken in order. First is `IMAGE_1`, last is `IMAGE_4`
- Blank lines do not matter. Some cities in your message have a gap after the colon and some do not, both are fine
- Lines starting with `#` are ignored, so you can leave yourself notes
- Stray text that is neither a heading nor a URL is skipped with a warning naming the line, rather than silently swallowed

Adding a city is five lines. `images.example.txt` in this folder shows the shape.

**You never have to create it by hand.** Run the script normally, paste the URLs when asked, and say yes to `Save these URLs to images.txt for next time?`. It writes the file, or adds to it if it already exists, sorted by city.

**It is entirely optional and never blocks you.**

| Situation | What happens |
| --- | --- |
| No `images.txt` at all | Asks for all four, as it always did |
| City has all four | Asks nothing, prints each URL and where it came from |
| City has only two | Uses those two, asks for the other two |
| City has no entry | Asks for all four, lists the cities it does know, offers to save |
| `--img1` etc. passed | The flag wins over the saved value |

### If you prefer JSON

`images.json` works too, and is used if there is no `images.txt`. Either an object or a plain array of four in `IMAGE_1` to `IMAGE_4` order:

```json
{
  "lisbon-en": {
    "IMAGE_1": "https://...",
    "IMAGE_2": "https://...",
    "IMAGE_3": "https://...",
    "IMAGE_4": "https://..."
  },
  "milan-en": ["https://...", "https://...", "https://...", "https://..."]
}
```

Use `--images <path>` to point at any other file. The extension decides how it is read.

## About the connection string

There is no config file and nothing is written to disk. You paste the string when the script asks, it is used once, and it is gone when the script exits.

If you would rather not retype a long staging string, put it in your shell session for as long as you need it:

```bash
export REGION_LOADER_URI="mongodb://user:pass@host:27017/wunderflats?authSource=admin"
```

The script offers it as the default with the password masked. This lives in your shell session only. Do not put that line in a file you commit.

**Two things to know.** What you type at the prompt is visible on screen, the same as it would be in a normal `mongosh` command. It is not saved anywhere, which is the difference. And the `--uri` flag puts the string into your shell history, so the script warns you when you use it.

**Anything that is not localhost asks twice.** You have to type the host name back before it writes:

```
  This is not your local machine.
  Type the host name to continue (staging-db.internal:27017): _
```

Get it wrong and nothing is written.

## What it does to your file

**Empty descriptions.** Every `description: null` becomes `description: ''`. `alt: null` and `caption: null` are left alone, those are allowed to be null. Any other null field is reported as a warning so you can decide.

**Collection name.** Always `regions`. You are never asked. If the input file names a different collection you will see it reported, for example `collection: regions  (input said 'cityPages', overridden)`. Use `--collection <name>` on the rare occasion you need something else.

**prismicId.** If the file has no `prismicId`, or has it set to `null` or blank, a random 16-character one is generated. It is only ever used when the document is created. An existing document keeps the `prismicId` it already has.

**Images, part 1: building the links.** For each URL you paste, six versions are written into the file, one per size, with the matching width appended:

```
px400:  ...LisbonImage1.jpg?auto=format,compress&w=400
px800:  ...LisbonImage1.jpg?auto=format,compress&w=800
px1200: ...LisbonImage1.jpg?auto=format,compress&w=1200
px1800: ...LisbonImage1.jpg?auto=format,compress&w=1800
px2400: ...LisbonImage1.jpg?auto=format,compress&w=2400
px3600: ...LisbonImage1.jpg?auto=format,compress&w=3600
```

The number after `w=` always matches the key it sits on. Four images, six sizes, 24 links written for you. The asset ID from your link is kept exactly as pasted, so the images actually load. These become `IMAGE_1` to `IMAGE_4` at the top of the file, just after `EMPTY_IMAGE`, which is never touched.

**Images, part 2: putting them in the right place.** The file you receive has `EMPTY_IMAGE` in every single slot. The script decides where the four real images go, **by heading, never by counting**:

| Image | Goes on the section whose heading matches |
| --- | --- |
| `IMAGE_1` | `Tips for Finding an Apartment...` (h2) |
| `IMAGE_2` | `Living in <City>` (h2) |
| `IMAGE_3` | `Sightseeing in <City>` (h3, anywhere in the document) |
| `IMAGE_4` | `Frequently Asked Questions...` (h2) |

Every other slot stays `EMPTY_IMAGE`.

**Why heading and not position.** City files are not all the same shape. "Rent Prices" is a separate h2 in Brussels, an h3 inside "Tips" in Zurich, and absent in Lisbon, Madrid and Milan. Counting sections put Brussels' second image on "Rent Prices" and pushed everything after it along by one. Matching the heading gets all of them right without knowing how many sections a city has.

Position is only a fallback, used when no heading matches, and it always warns. You will see one of these:

- nothing extra, the heading was where it usually is
- `IMAGE_2: matched the "Living in <City>" h2 at h2 #3, not the usual position` — found it elsewhere, correct, nothing to do
- `IMAGE_2: nothing matches ... Falling back to h2 #2 "..." by position. Check this one.` — worth opening the output
- a numbered list asking you to choose, when it cannot tell

That last case looks like this:

```
  IMAGE_3 needs a section. Expected the "Sightseeing in <City>" h3.
       1) h2 #1 > h3 #1        "Living in Brussels City Center, the Pentagon and Louise"
       ...
       7) h2 #3 > h3 #2        "Things To Do in Brussels"
       0) skip this image
  Which one for IMAGE_3? [0-15]: _
```

Sections already taken by another image are left out of the list, so the same slot cannot get two images.

**In a batch it refuses instead of asking.** With `--all` there is no sensible way to stop and ask, so an undecidable file stops the run with the reason and a pointer to `--outline`. Nothing is guessed.

### Seeing the structure of a file

```bash
node region-seo-loader.js brussels-en --outline
```

Prints the h2 and h3 tree, shows where each image would land, then stops without writing anything. This is the first thing to run when a city behaves oddly.

```
  OK    found 4 h2 section(s), 13 h3 section(s)
      h2 #1  "Tips for Finding an Apartment in Brussels"
          h3 #1  "Living in Brussels City Center, the Pentagon and Louise"
          ...
      h2 #2  "Rent Prices in Brussels"
      h2 #3  "Living in Brussels"
          h3 #2  "Sightseeing in Brussels"
      h2 #4  "Frequently Asked Questions About Renting in Brussels"

  OK    IMAGE_1 -> h2 #1  "Tips for Finding an Apartment in Brussels"
  OK    IMAGE_2 -> h2 #3  "Living in Brussels"
  OK    IMAGE_3 -> h2 #3 > h3 #2  "Sightseeing in Brussels"
  OK    IMAGE_4 -> h2 #4  "Frequently Asked Questions About Renting in Brussels"
```

**Safety check.** Before anything goes near the database, the generated file is checked for valid JavaScript. A broken file never reaches Mongo.

## Flags

You only need these if you want to skip the questions.

| Flag | What it does |
| --- | --- |
| `--all` | Every `.js` in `input/`, instead of naming one city |
| `--outline` | Print the h2/h3 tree and where each image would land, then stop |
| `--dry-run` | Prepare and save the output file, never touch a database |
| `--collection <name>` | Write somewhere other than `regions`. Rarely needed |
| `--img1` .. `--img4` | The four image links, in `IMAGE_1` to `IMAGE_4` order. Wins over the saved file |
| `--images <path>` | Use a different saved-URL file instead of `images.txt` |
| `--uri <string>` | Connection string. Goes into your shell history, so prefer the prompt |
| `--out <path>` | Save somewhere other than `output/<name>.js`. Not valid with `--all` |
| `--yes` | Skip the yes/no prompt for local. Non-local still asks |

## If something goes wrong

The script stops with a plain message and writes nothing.

| Message | What to do |
| --- | --- |
| `could not find "paris-fr". Looked in: ...` | The file is not in `input/`. Check the name |
| `no .js files in .../input` | `--all` found an empty folder |
| `--all takes every file in input/, so do not name one as well` | Use one or the other, not both |
| `could not find db.getCollection(COLLECTION).insertOne(...) or .updateOne(...)` | The file is shaped differently than expected. Send it over and the script can be adjusted |
| `the document has no slug and lang, so there is nothing to match on` | The write has no `slug` or `lang` to key off. Check the file |
| `could not find a var EMPTY_IMAGE = { ... }; block` | Same as above |
| `found no image: assignments in the file` | Same as above, the h2/h3 structure is not what the script expects |
| `host is "example.com", expected images.prismic.io` | The link you pasted is not a Prismic link |
| `asset "..." does not match <16-char id>_<filename>` | The link is missing the ID part, copy it again from Prismic |
| `that does not look like a mongodb:// connection string` | Check what you pasted |
| `that did not match. Nothing was written.` | You typed the host name wrong at the confirmation. Run it again |
| `mongosh not found on PATH` | Install mongosh, or open a new terminal |
| `images.json is not valid JSON` | A comma or bracket is off. The message gives the line and column |
| `images.txt: line 4: not a heading or a URL` | Stray text in the links file. Harmless, it was skipped |

## What the input file needs to look like

The script expects the structure used in the Lisbon file:

- one line reading `var COLLECTION = '...';`
- a `var EMPTY_IMAGE = { ... };` block
- an `h2s` array where each section has `image:` and `text:` on consecutive lines, h3 sections indented deeper than their h2
- a write statement, in either of the two shapes that get produced:
  - `db.getCollection(COLLECTION).insertOne({ _id, h2s, lang, slug, title, ... })`
  - `db.getCollection(COLLECTION).updateOne({slug, lang}, {$set: ...}, {upsert: true})`

The document must carry `slug` and `lang` somewhere, since that is what the write matches on.

It does **not** need `IMAGE_1` to `IMAGE_4` to already exist, those are created for you. It does not need `prismicId` either. It works whether the document carries only `h2s` or the full field list.

You can also re-run the script on a file it produced earlier. It recognises its own output and rebuilds cleanly instead of nesting.

If a file does not match, the script names the exact thing it could not find and stops, rather than half-changing your file.

## Changing the rules

Two tables near the top of `region-seo-loader.js`.

Which fields are written only at creation and never touched again:

```js
const INSERT_ONLY_FIELDS = ['metaDescription', 'metaTitle', 'slug', 'lang', 'title', 'prismicId'];
```

Anything not in that list goes into `$set` and is replaced on every run. Fields stripped from the write entirely:

```js
const DROPPED_FIELDS = ['_id'];
```

Where the images go. Each rule is a heading to match, with a position used only as a fallback:

```js
const PLACEMENTS = [
  { varName: 'IMAGE_1', level: 'h2', match: /^\s*tips for finding\b/i,   position: { h2: 0 } },
  { varName: 'IMAGE_2', level: 'h2', match: /^\s*living in\b/i,          position: { h2: 1 } },
  { varName: 'IMAGE_3', level: 'h3', match: /^\s*sightseeing\b/i,        position: { h2: 1, h3: 1 } },
  { varName: 'IMAGE_4', level: 'h2', match: /^\s*(frequently asked questions|faqs?)\b/i, position: { h2: 2 } }
];
```

If a city words a heading differently and you expect more of them, widen the regex here rather than answering the picker every time.

The prompts, the placement, the generated file and the summaries all read from these, so changing them changes everything consistently.
