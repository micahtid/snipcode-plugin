# Security

## Reporting a vulnerability

Report privately, not as a public issue.

Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/micahtid/snipcode-plugin/security/advisories/new).
That opens a private advisory only the maintainers can see. If the form is unavailable, open a
public issue titled "security contact request" with no details, and a maintainer will reply with
a private channel.

Please include the snipcode version, the page or fixture that triggers it, and what you
observed. A first response should come within a week.

## Supported versions

The latest published release is the supported one. Fixes land on `main` and ship in the next
release rather than as patches to older versions.

## What is in scope

snipcode loads a url in a headless Chromium and writes files under `--out`. In scope:

- Anything that reads or writes outside `--out`, or reaches the local disk or network from a
  `<url>` argument. `<url>` is gated to http and https for exactly this reason.
- Code from the loaded page executing in the Node process rather than in the page.
- An extracted artifact that carries something from the page it should not, such as a
  credential in a url or a header.

Out of scope:

- The loaded page running its own scripts in its own tab. That is what a browser does, and the
  page is chosen by whoever runs the command.
- Whatever a snipped artifact does once you paste it into your own project. Read what you paste.
- Reports from a page you were not authorized to load.
