# Status accuracy and history update

## Findings and fixes

- Homepage resource latency previously accumulated HTML plus asset checks against
  a single-request threshold. Probes now retain the original request duration,
  compare the slowest individual request, inherit each component's deadline and
  reuse eligible HTTP/TLS connections.
- Successful slow probes previously contributed to outage streaks. Degradation
  and unavailability are now distinct; outages still require consecutive failed
  observations, and consecutive available observations restore service even when
  their speed differs.
- Easy SWU's 123-request production window had zero errors and an exact P95 of
  3892 ms, previously shown as 5000 ms. API/Bridge now compute bounded exact
  nearest-rank quantiles and omit incomplete latency samples. Status uses a
  5-second default business budget and a separately managed 10-second teaching
  budget, preserving independent health and error-rate failures.
- History now groups events by month and local calendar day, shows event time,
  latest progress and recovery phase, and preserves navigable incident links.
  Service/group filters and month selection work locally over the real 90-day
  response. History colors describe past impact, not the current status.
- Filter popovers stay mounted for reversible opacity/transform transitions
  (160/180 ms), with outside-click/Escape dismissal, focus restoration, inert
  closed content and reduced-motion support. No new runtime dependency is needed.
- Patch the existing source-map-js development dependency to 1.2.2 so the release
  passes the current security audit; other dependencies remain pinned.

## Validation

Status backend: 44 tests passed, including an isolated MySQL integration database.
Frontend: 11 tests passed, including day grouping, real incident links, filtering,
month selection, closing transitions and keyboard focus. Backend: 1711 passed,
4 skipped, plus 10 focused monitoring tests. Lint and formatting passed.
GitOps rendering and 18 scope / 6 production-gate tests passed.

The OpenAI reference and local implementation were captured and compared in the
connected Chrome extension backend. Desktop rhythm and day/event alignment were
checked; the mobile layout and scrollable filter have no horizontal overflow.
Real component filtering, Escape and the transition styles were verified in the
browser. LaZy Campus branding, Chinese labels and explicit recovery states are
intentional product differences. Historical observations/incidents are retained.

Publishing follows each repository's exact-SHA CI and the single Flux image
writer / validated production promotion. Temporary public visibility for the two
private repositories is authorized only to complete the blocked CI chain;
restore and verify private visibility after the relevant publishing/promotion
work completes.
