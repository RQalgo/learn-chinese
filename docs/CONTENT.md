# Content guide

How the lessons in `data/` are written. Schema: see `docs/ARCHITECTURE.md` §4.

## Learner profile

* Absolute beginner in Mandarin, fluent English, lives in **Singapore**.
* Learns by **listening only**, on a phone, during 5–10 minute commutes.
* Sees pinyin on screen; does not need to learn characters.

Everyday Singapore settings (MRT, hawker centre, kopi, HDB) are welcome where natural,
but the language is **standard Mandarin (普通话)** throughout.

## Unit plan (24 units)

| # | id / file | Title | Focus |
|---|---|---|---|
| 1 | u01-greetings | Greetings | hello, goodbye, thanks, sorry, how are you |
| 2 | u02-numbers | Numbers 0–10 | 零–十, yes/no (是/不是, 对/不对), 好 |
| 3 | u03-about-me | About me | 我/你/他/她, name (叫, 姓), country, where from |
| 4 | u04-family | Family | 爸爸 妈妈 哥哥…, 有/没有, how many people |
| 5 | u05-numbers-age | Bigger numbers & age | 11–100, 几/多少, 岁 |
| 6 | u06-food-drink | Food & drink | rice, noodles, water, tea, coffee, 吃/喝, 想/要 |
| 7 | u07-eating-out | Eating out | ordering at a hawker centre/restaurant, 好吃, 买单 |
| 8 | u08-shopping | Shopping & money | 块/元/毛, 多少钱, 贵/便宜, 买/卖 |
| 9 | u09-time-dates | Time & dates | days of week, months, today/tomorrow, 点/分/半 |
| 10 | u10-daily-routine | Daily routine | get up, go to work, eat, sleep, 早上/晚上 |
| 11 | u11-transport | Getting around | MRT 地铁, bus, taxi, 坐/开/走, 怎么去 |
| 12 | u12-places | Places in the city | bank, hospital, school, toilet, 在哪儿, 左/右/前/后 |
| 13 | u13-weather | Weather | hot, cold, rain, sunny, 天气怎么样, 有点儿 |
| 14 | u14-hobbies | Hobbies & free time | 喜欢, sports, music, films, 周末 |
| 15 | u15-work | Work & office | jobs, 公司, 开会, busy, 上班/下班 |
| 16 | u16-plans | Making plans | invitations, 一起, 有空吗, 可以, 打电话 |
| 17 | u17-health | Health & body | body parts, 疼, 生病, 医生, 药 |
| 18 | u18-feelings | Feelings & opinions | 高兴, 累, 觉得, 怎么样, 太…了 |
| 19 | u19-home | Home | rooms, furniture, 住, HDB flat, 干净 |
| 20 | u20-travel | Travel & hotel | airport, passport, 旅游, 房间, 预订 |
| 21 | u21-describing | Colours, clothes & describing | colours, 衣服, 大/小, 长/短, 漂亮 |
| 22 | u22-animals-nature | Animals & nature | 猫 狗 鸟, 树 花 海, 可爱 |
| 23 | u23-comparing | Comparing & choosing | 比, 更, 最, 还是, 一样 |
| 24 | u24-conversations | Everyday conversations | longer mixed dialogues reviewing everything |

## Per unit

* **26 items**: 12 `word`, 8 `phrase`, 6 `sentence` — in that order in the file, IDs
  `w01…w12`, `p01…p08`, `s01…s06`.
* **2 dialogues**: 4–8 lines each (units 1–8: 4–5 lines; later units up to 8),
  each with **2 comprehension questions** in English with 1 answer + 3 distractors.
* Items earlier in the file should be easier; sentences reuse the unit's words.
* Later units may reuse vocabulary from earlier units freely; avoid vocabulary from
  much later units.

## Length and difficulty

* Words: 1–3 syllables (common HSK 1–2 vocabulary first).
* Phrases: 2–6 syllables, fixed expressions or short chunks (e.g. 多少钱, 没关系).
* Sentences: units 1–8 ≤ 10 characters; units 9–16 ≤ 14; units 17–24 ≤ 18.
* Dialogue lines follow the same limits.

## Pinyin rules

* Tone marks (ā á ǎ à), never tone numbers. ü written as ü (lǜ, nǚ).
* Separate **words** with spaces, not syllables: `péngyou`, `xièxie`, `Zhōngguó`, `wǒ shì Xīnjiāpōrén`.
* Neutral tone has no mark: `ma`, `de`, `le`, `men`, `zi`, second syllable of `xièxie`, `bàba`.
* Write the **spoken (sandhi) tone for 不 and 一**, as textbooks do: `bú shì`, `bú yào`,
  `yí gè`, `yì diǎnr`… but write **third-tone sandhi in citation form** (`nǐ hǎo`, not `ní hǎo`).
* Sentences start with a capital letter and keep the hanzi's final punctuation
  (`?` `!` `.` — use ASCII in pinyin, full-width in hanzi: `？` `！` `。` `，`).
* Proper nouns capitalised: `Wáng Xiǎomíng`, `Xīnjiāpō`.

## English rules

* `english` is what the learner taps as the right answer, so keep it **short and
  unambiguous**. Words: lowercase (`hello`, `older brother`). Phrases: lowercase, no
  final period unless a question (`how much is it?`). Sentences: normal sentence case
  with punctuation.
* Disambiguate when needed: `you (polite)`, `he / him`, `to want (to)`.
* No two items in the same unit share an `english` string. Put synonyms in `alt`.
* Dialogue questions are about meaning, answerable only by understanding the audio
  ("What time do they agree to meet?" → "Seven o'clock").

## Audio-friendliness (the text is fed to a TTS voice)

* Write numbers, times and prices in characters: `三点半`, `十五块`, not `3:30`, `$15`.
* Avoid Latin letters inside hanzi (no `MRT` — write 地铁; no `OK` — write 好的/可以).
* Avoid rare characters and very ambiguous polyphones in short items where the voice
  might pick the wrong reading. If you must use one (e.g. 了 le/liǎo, 行 xíng/háng,
  长 cháng/zhǎng), make sure the context is clear.

## Validation

Run `python3 tools/validate_content.py` — it must exit 0. It checks the schema, IDs,
duplicate English, sentence length, and compares pinyin with `pypinyin` (reporting
mismatches as warnings to review, because pypinyin is not always right either).
