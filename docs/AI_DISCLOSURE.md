# AI disclosure

> **This project was written largely with generative AI.** Read [What this means](#what-this-means) before
> you use, contribute to or reuse the code.

## Who did what

| Part | Done by |
|---|---|
| Idea, requirements, design decisions, what to build next | the human author |
| Everyday use and testing on real servers and browsers (listed in the [README](../README.md#what-works)) | the human author |
| Research into Overleaf's internals, the design, all source code, the build scripts, the tests, the documentation | AI (Anthropic Claude, via Claude Code), from the author's instructions and bug reports |

## How the code was checked

- An automated test suite: unit tests, engine tests in a real browser, and end-to-end tests that drive the
  extension in Brave against a local Overleaf Community Edition in Docker. They cover compiling, error
  markers, SyncTeX, collaborators' edits, stopping, falling back to the server, large projects and the popup.
- The author's use on real servers and browsers.

The tests show that the tested paths work. They don't replace a review.

## What this means

- **No human code review.** Structure, style and comments are the AI's. Expect bugs in cases the tests don't
  cover, and assumptions about Overleaf that hold for the tested versions only.
- **It runs inside your logged-in Overleaf page.** The page script sees your project and acts with your
  session: it reads every document and file of the open project and answers Overleaf's compile requests.
  It doesn't change your project and sends its content nowhere except to your Overleaf server (see the
  README's [Privacy and network](../README.md#privacy-and-network)). This hasn't been audited; if you review
  one part, review `extension/src/page/` first.
- **Overleaf's internal requests aren't a public API.** LocaLeaf imitates parts of them; an Overleaf update
  can break it. When LocaLeaf itself fails, it falls back to the server.
- **When the docs and the tests disagree, trust the tests.**

## Legal notes

*General information, not legal advice.*

- **Ownership:** Anthropic's terms assign to the user whatever rights Anthropic has in the outputs, subject
  to those terms. Check the current [Anthropic terms](https://www.anthropic.com/legal).
- **Copyright may be limited.** Many jurisdictions protect only works of human authorship (e.g. Germany:
  § 2 (2) UrhG; the US Copyright Office requires human authorship). Purely AI-generated parts may not be
  protected. The license applies to the extent that rights exist.
- **Third-party material:** AI output can resemble code the model saw in training. No copied code is known;
  if you recognise code from another project, please open an issue.
- **Dependencies keep their own licenses:** see [THIRD_PARTY.md](THIRD_PARTY.md).
- **No affiliation:** LocaLeaf is not affiliated with or endorsed by Overleaf, TeXlyre, CTAN or Anthropic.
- **No warranty:** provided as is, see the [license](../LICENSE).

## Contributing

Human and AI-assisted contributions are both welcome. Please say in the pull request whether and how AI was
used, and what you tested (browser, Overleaf version). A human review of the existing code, especially
`extension/src/page/`, is the most valuable contribution right now.
