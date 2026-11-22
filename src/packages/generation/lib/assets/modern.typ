// Modern resume template (#30): IBM Plex Sans (vendored, OFL), single column, one accent
// colour on headings only. ATS rules (#6): no tables or text boxes, contact details in the
// body, no graphics, real text in reading order. Rendered as tagged PDF/UA-1.
// Every value arrives as a string in `sys.inputs.data`, so no value is ever read as markup.
#let r = json(bytes(sys.inputs.data))
#let accent = rgb("#1f4e79")
#let muted = luma(60)
#set document(title: r.identity.name + " Resume", author: r.identity.name, date: none)
#set page(paper: "us-letter", margin: (x: 0.7in, y: 0.6in))
#set text(font: "IBM Plex Sans", size: 9.8pt, lang: "en")
#set par(justify: false, leading: 0.55em, spacing: 0.6em)
#set list(marker: [–], indent: 0.2em, body-indent: 0.5em, spacing: 0.45em)

#let present(value) = value != none and value != ""
#let joined(sep, ..parts) = parts.pos().filter(present).join(sep, default: "")
#let dates(item) = joined(" – ", item.start, item.end)
#let section(title) = {
  v(0.8em)
  heading(level: 2, text(size: 10.5pt, weight: "bold", fill: accent, title))
  v(0.05em)
}
#show heading: set block(above: 0em, below: 0.3em)
#let bullets(items) = for b in items [- #b.text]

#heading(level: 1, text(size: 22pt, weight: "bold", r.identity.name))
#v(0.1em)
#text(fill: muted, joined("   ·   ", r.identity.email, r.identity.phone, r.identity.location, ..r.identity.links))

#if r.summary != none [
  #v(0.4em)
  #r.summary.text
]

#if r.skills.len() > 0 [
  #section("Skills")
  #for g in r.skills [
    #text(weight: "semibold", g.group) #h(0.4em) #g.items.map(i => i.text).join(" · ") \
  ]
]

#if r.experience.len() > 0 [
  #section("Experience")
  #for e in r.experience [
    #text(weight: "bold", joined(", ", e.employer)) #h(0.4em) #text(fill: muted, joined("", e.location)) #h(1fr) #text(fill: muted, dates(e)) \
    #if present(e.title) [#text(weight: "semibold", e.title)]
    #bullets(e.bullets)
    #v(0.35em)
  ]
]

#if r.projects.len() > 0 [
  #section("Projects")
  #for p in r.projects [
    #text(weight: "bold", joined("", p.name)) #h(0.4em) #text(fill: muted, p.links.join("   ·   ", default: ""))
    #bullets(p.bullets)
    #v(0.35em)
  ]
]

#if r.education.len() > 0 [
  #section("Education")
  #for ed in r.education [
    #text(weight: "bold", joined("", ed.school)) #h(1fr) #text(fill: muted, dates(ed)) \
    #if present(ed.degree) [#ed.degree]
    #bullets(ed.bullets)
    #v(0.35em)
  ]
]

#if r.certifications.len() > 0 [
  #section("Certifications")
  #for c in r.certifications [
    #joined(", ", c.name, c.issuer) #h(1fr) #text(fill: muted, joined("", c.issued)) \
  ]
]
