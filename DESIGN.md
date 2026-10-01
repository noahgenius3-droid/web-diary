# Cordial design notes

How Cordial's interface is put together, so new work fits the existing app instead of inventing a new look. The tokens themselves live in `:root` in [style.css](style.css), with dark-mode values under `[data-theme="dark"]`. Always use the tokens; never hard-code a colour that a token already covers.

## Character

Cordial is a warm, personal place: a diary first, a social app second. Pages should feel calm and readable, never busy. The content (a note, a post, a photo) is the hero; the interface steps back.

## Tokens (roles)

| Role | Token |
|---|---|
| Page background / panels | `--bg`, `--panel` |
| Cards and sheets | `--surface` |
| Text, secondary text, hints | `--text`, `--text-muted`, `--text-faint` |
| Lines | `--border`, `--border-strong` |
| Brand / primary action | `--accent`, `--accent-hover`, `--accent-soft`, `--on-accent` |
| Fields and quiet fills | `--input` |
| Corners | `--radius` (cards 14–16px; pills only for small controls) |
| Display type | `--serif` (Fraunces) for editorial headings: note titles, Playnote, dates |
| Body type | Inter / the app font, 16px minimum in inputs |

## Hierarchy rules

- **One primary action per screen.** Only it gets the filled `--accent` button; everything else is a chip, a link, or an icon.
- **Section titles are just words** (about 1.05rem, weight 700), with an optional "See all" link on the right. No badge tiles or eyebrow labels above headings.
- **Rails before walls.** A list of more than a few cards of the same kind becomes a horizontal rail on phones.
- **Progressive disclosure.** Secondary actions go in a sheet or menu (Share, "…"). Long lists show a few items, then "Show all".
- **Elevation is declared once.** A card has a border *or* a shadow, not both.
- **Hover styles only on devices that can hover:** `@media (hover: hover) and (pointer: fine)`.

## Feed

This follows the Feed PRD and Feed design spec (content first, identity second, actions third).

- **Modes:** three underline tabs (For you, Following, Latest), with search and a filter menu. The filter menu holds Popular this week, Saved posts, post type and Reels. An active sort or filter shows as a removable chip.
- **Width and targets:** the Feed column is `--feed-content-max` (620px). Touch targets are `--feed-touch-target` (44px).
- **Loading:** posts load 15 at a time and the next 15 load as you near the end. A "Show more posts" button stays for keyboards.
- **States:** the loading skeleton mirrors a post, including its action row. A failed load shows "Couldn't load the Feed" with Try again, never an empty Feed.
- **Stories:** a row of avatars above it.
- **Composer:** one line, "What would you like to share?", with a photo button and a "+" for every other way to create. Its tools appear once you start writing.
- **Posts:**
  - Each post has four actions: Like (hold for other reactions), Comment, Share and Save.
  - The Share sheet holds repost or reshare, add to story, send to a friend, message the author, copy link, and the device's share menu.
  - The "…" menu holds tertiary actions such as report, copy text and audience.
- **A shared note** (title, no media) is shown as a note: note-colour top edge, "Note · n min read", a serif title, a four-line preview and "Read note". The author sees "Open in Notes" instead, which opens the original note: Notes stay the source of truth.
- **A Playnote result** is shown as a Playnote card: its title (for example "Daily trivia"), the score, the text, and one "Play today's challenge" button.
- **Comments:** under each post, a short preview, "View all", and a quiet "Add to the conversation…" line. Writing a comment happens in the post view.
- **Desktop layout:** the Feed column (max about 640px) and a right column with you (posts, saved, scheduled, stats), trending tags and people. Boxes with nothing to show are not drawn.
- **Phones:** posts run edge to edge, separated by a hairline.

## Explore and Playnote

- **Explore:**
  - The page opens on search, with trending topics as one line under it.
  - "For you" shows one featured post, then rails: trending, live (only when something is live), reels, Playnote, people, news.
  - Everything else is under "More to explore" and the tabs.
- **Playnote:**
  - Daily trivia leads.
  - The other daily challenges sit in one row.
  - Games and topics are compact tiles; topics show four, then "Show all".

### Explore search

Tapping the search box enters search mode: the tabs and sections step aside.

- **Before typing:** shows Recent searches (kept on this device, each removable, plus "Clear all"), Topics and People.
- **Results:**
  - The list updates as you type, after a short pause.
  - Results are grouped into vertical lists: Tags, People, Notes ("Read"), Playnote ("Play"), Posts, Library and Communities.
- **Leaving:** Cancel or Esc leaves search mode.
- **For you:** includes a "Notes worth reading" rail.

## Chat

Chat is for talking, so the conversation is the hero.

- **Header:** back, avatar and name (both open the profile), voice and video call, search, details, and more. All icons share one quiet treatment.
- **Details panel:** opens by itself only on very wide screens, and remembers your choice.
- **Message runs:** messages from one person sit close together, with the avatar shown only on the last.
- **Scrolling:** a new message only scrolls you down if you were already near the bottom. Otherwise "Jump to latest" appears.
- **Loading:** a conversation that is loading shows placeholder bubbles.
- **No flicker:** a re-render never fades the conversation.
- **Opening a chat (phones):** a short slide of 200ms, with none when reduced motion is on.
- **"+" menu:** photo, document, voice note, Note (one of your notes, never a private one), Playnote challenge (today's trivia, or a Wordplay match), drawing, live location, contact card, schedule, wording and formatting.
- **Playnote challenges** show as a card with "Play today's challenge".
- **Inbox on phones:** one compact line ("Hi, Ada" and "2 new messages") with the contact row, so conversations come first.

## Motion and accessibility

- **Motion:** short and calm; respect `prefers-reduced-motion`.
- **Feedback:** press feedback happens on `:active`, not only on click.
- **Controls:** every icon-only control has an `aria-label`.
- **Touch targets:** at least 40px.
- **Meaning:** never rely on colour alone.
