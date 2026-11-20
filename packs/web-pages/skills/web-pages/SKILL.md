---
name: web-pages
description: How to make a web page that real people will look at (a coming-soon page, a landing page, pricing, an about page, a dashboard or tool screen) so it reads as designed, not as a form; the fundamentals, the pattern for each kind of page, and the look-before-you-ship review. Use it for any page outside the console.
license: MIT
metadata:
  owner: company
  version: "1.0"
---

# Web pages people will see

A spec is not a design. A page can meet every rule in a brief (colours, form states, accessibility, wording) and
still read as a form, because nobody decided what the visitor should see first, want, and do. Decide that before
any code, check it in a screenshot before you ship, and fix what the screenshot shows.

## 1. Decide three things first, in writing

Put these three lines at the top of the page's brief. If you cannot fill them in, the page is not ready to build.

1. **Who arrives, from where, knowing what.** ("A shop owner on a phone, from a friend's link, who has never heard
   the product's name.")
2. **The one thing they should do.** One. A second action is allowed only if it is clearly smaller.
3. **Why they would want to.** The benefit in their words, not a description of the product's parts.

## 2. The fundamentals

1. **One main action per page.** One filled, coloured button. Every other action is visibly quieter: a plain link, an
   outlined button, small text. Two buttons that look the same tell the visitor both matter equally. An action
   nobody needs often (unsubscribe, delete, remove my data) is a small link near the footer, never a second
   headline button.
2. **Hierarchy you can see from across the room.** Squint at the screenshot: the order things catch your eye must be
   the order you want them read. One large headline, one short supporting line, then the action. Size, weight and
   space carry the order; colour is for the action and for meaning, not for decoration.
3. **The headline is the benefit, not the name.** The name is already in the logo. "Run your shop with an AI team you
   can check on" beats the product's name repeated in large type.
4. **Show, then tell.** A screenshot, a short example, a "here is your morning" scene, three concrete things it
   does. A visitor understands a picture of the product in one second and a definition in thirty.
5. **Fine print is fine.** Privacy, removal and legal lines go in one short line under the action or in the footer,
   in small type, with a link for the rest. Never let required small print outweigh the pitch. Never name your
   hosting provider, database or tools to a customer: they want "we only use your email for this", not where it
   is stored.
6. **Short words, short lines.** Sentences under about 20 words, paragraphs of one to three sentences, a line length
   of about 45 to 75 characters on a laptop. No word the visitor would need explained.
7. **One name, written one way.** The product's name is spelled identically in the logo, the title, the headline and
   the text. Decide it once in the brief.
8. **Use the whole screen.** Design the phone first, then the laptop: on a wide screen the content is centred with
   room to breathe, and the page does not end in a large empty band. A page that is mostly blank below the fold
   reads as unfinished.
9. **Consistent spacing.** Pick one spacing scale (for example 4, 8, 16, 24, 32, 48, 64) and use only those values.
   Related things sit closer together than unrelated things; that alone groups the page.
10. **It must feel like someone made it.** One distinctive element that carries the brand (a colour used with
    restraint, a type pairing, an illustration, a photo with a point of view) beats several decorations.

## 3. Patterns by kind of page

Pick the pattern, then adapt it. Each lists its parts top to bottom and the mistakes it invites.

**Coming soon (before launch).** Logo; a benefit headline; one line on who it is for; the email field and its one
button side by side; a single line of reassurance under it ("One email at launch. Nothing else."); optionally one
picture or three short "what it will do" lines; footer with the small print and the removal link.
Mistakes: a second big form for removing an address; the product's definition instead of a benefit; paragraphs of
privacy text above the fold.

**Landing page (after launch).** Hero: benefit headline, supporting line, main action, a picture of the product. Then
three to five sections, each one idea with a short heading and a visual: what it does, how it works in three steps,
who it is for, proof (a quote, a number, a logo), the price or "from" price, the main action again, footer.
Mistakes: features listed as parts ("a dispatcher, a pacer") instead of outcomes; no picture of the product; the
action only at the top.

**Pricing.** The plans side by side as cards on a laptop, stacked on a phone; the recommended plan marked once;
each card: name, price with its period, who it is for in one line, three to six things included, its button. Under
the cards: what everything includes, then a few common questions. Any condition that changes the price (planned,
may change, taxes) is stated right above the cards, once.
Mistakes: more than one "recommended"; prices without a period; the same button on every card with no hint which
to pick.

**About or information.** A headline that states the point; short sections, each a heading and two to four lines;
one picture or diagram where the idea has a shape (how it works, who does what). Ends with the main action.
Mistakes: a wall of text; headings that are labels ("Overview") instead of points ("Every decision is recorded").

**Dashboard or tool screen.** The answer to "is everything all right?" first, in words and one status colour; then
what needs the person's attention, as a short list with the action on each item; then detail behind a click. Empty
states say what will appear and how to make it appear.
Mistakes: every number at the same size; colour used for decoration so a real warning does not stand out; an empty
page with no explanation.

## 4. Look before you ship (required)

1. Take a screenshot at phone width (390 px) and laptop width (1440 px), for example with headless Chrome:
   `google-chrome --headless=new --hide-scrollbars --window-size=390,1600 --screenshot=phone.png <url>`.
2. Look at each picture as the visitor from section 1 would, for five seconds, then answer in writing:
   - What did my eye land on first, second, third? Is that the order I intended?
   - Is there exactly one main action, and is it obvious?
   - Can I tell what the product does for me without reading the small print?
   - Is anything cut off, cramped, misaligned, or is a large part of the screen empty?
   - Is the name spelled the same everywhere?
3. Fix what failed and take the screenshots again. Ship only when every answer is right.
4. Hand the screenshots and the answers to the reviewer with the change, so they review what the visitor sees, not
   only the code.

## 5. When the brief is wrong

If a brief asks for something that breaks a fundamental (two equal main actions, three paragraphs of small print
above the action), raise it with whoever wrote the brief before building, with the fundamental it breaks and a
better option. Building it as written and noting the problem afterwards wastes a round.
