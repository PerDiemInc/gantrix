---
name: google-slides
description: Build slide decks in Google Slides - create a deck in the user's Drive, add slides with layouts, bullets, colours and speaker notes, and check the result.
version: 1.0.0
tools: [read_file, write_file, list_files]
mcp-servers:
  slides:
    command: gantrix-slides-mcp
auto-approve: [slides_add_slide, slides_list_slides]
---
Use the slides tools to build a deck in Google Slides. Creating a deck asks the user first;
adding slides to it doesn't.

1. Write the outline to slides/outline.md first: one line per slide with its layout, title and
   the single point it makes, plus speaker notes. 10 slides or fewer unless asked.
2. slides_create_presentation with the deck's title. Keep the presentation_id it returns.
3. slides_add_slide for each slide, in order:
   - TITLE for the first slide (title + subtitle in body).
   - SECTION_HEADER between parts.
   - TITLE_AND_BODY for a point with at most 4 short bullet lines (bullets: true).
   - TITLE_AND_TWO_COLUMNS to compare (body = left, right = right).
   - BIG_NUMBER for one number that matters (title = the number, body = what it means).
   - Put the detail in notes, not on the slide. Titles are a full sentence that states the point.
   - Use the same two or three colours on every slide (background, text_color), with text
     contrast of at least 4.5:1.
4. slides_list_slides to check that every slide is there and reads well.

If the tools say Google isn't connected, keep slides/outline.md as the deliverable and say how
to connect it (npm run slides:auth). End with the deck's link.
