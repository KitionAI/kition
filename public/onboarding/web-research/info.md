# Web Research

This guide tests the reusable browser handoff: open a website in Kition's embedded browser, continue the rest of the same Agent request after the page is ready, and produce only the output the user requested.

## Before you start

- Use the desktop application because the embedded browser is a desktop capability.
- Configure an AI model under **Settings > AI Models**.
- If the target website is unavailable on your current network, configure and test the shared proxy under **Settings > Network** before running the prompt. The embedded browser uses the same saved proxy.
- Open the Agent from any workspace document.
- Sign in only when the target website requires it.

## Copy this ready-to-run example

The website and output below are test inputs. Replace them to reuse the same flow with another site or another kind of result.

```text
Open youtube.com in the built-in browser, collect every video card currently loaded on the homepage, and write the results into a new structured table file. Include Title, Video URL, Channel or Author, Views, Duration, Published At, Thumbnail or Cover, Source Page, Captured At, and Summary or Notes. Use Video URL as the unique key. Continue automatically after the browser opens, and do not mark the task complete until the rows are saved. If browser access or extraction is unavailable, report the blocker instead of creating an empty completed table.
```

## Reuse it with another website

Use this structure for documentation, news, product research, page summaries, screenshots, downloads, or other browser tasks:

```text
Open <website-url> in the built-in browser and <describe the work to perform on the loaded page>. <Describe the exact output or action you want, if any>. Continue automatically after the browser opens. Do not mark the task complete until the requested result is verified. If browser access or the requested page operation is unavailable, report the blocker instead of fabricating a result.
```

Examples of valid substitutions include summarizing a documentation page into the active document, comparing products into a structured table, capturing a screenshot, or collecting links into a CSV file. The Agent must follow the original request rather than assuming that every browser task writes a table.

## Expected behavior

1. The Agent enables browser access when the request identifies a website and browser work.
2. The Agent opens the requested website without requiring a second instruction.
3. If the original request contains work beyond opening the page, the Agent resumes that same request after the page is ready.
4. A request that only says to open or visit a website stops after opening it.
5. The Agent creates, updates, downloads, captures, or summarizes only what the original request specifies.
6. The final response is shown only after the requested result is verified.

## Verify the result

- Confirm that the browser tab uses the domain from the prompt rather than a fixed website.
- Confirm that only one visible user message appears when automatic continuation is required.
- Confirm that the output type and fields match the prompt instead of a built-in table schema.
- Try `Open youtube.com` by itself and confirm that no table or file is created.
- Replace `youtube.com` with another accessible website and confirm that the same handoff works.

## Failure behavior

If the browser cannot open the page or expose the context required by the task, the Agent must report a blocked or failed state. It must not fabricate page content, create an unrelated fallback artifact, or claim completion.
