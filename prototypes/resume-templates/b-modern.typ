// PROTOTYPE resume template B, "Modern": sans (IBM Plex Sans, vendored), left-aligned,
// one accent colour on headings only, skills first for keyword-heavy technical roles.
// ATS rules (#6): single column, no tables or text boxes, contact in the body, no graphics, real text.
#let r = json(sys.inputs.at("data", default: "resume.json"))
#let accent = rgb("#1f4e79")
#set document(title: r.identity.name + " Resume", author: r.identity.name)
#set page(paper: "us-letter", margin: (x: 0.7in, y: 0.6in))
#set text(font: "IBM Plex Sans", size: 9.8pt, lang: "en")
#set par(justify: false, leading: 0.55em, spacing: 0.6em)
#set list(marker: [–], indent: 0.2em, body-indent: 0.5em, spacing: 0.45em)

#let section(title) = {
  v(0.8em)
  text(size: 10.5pt, weight: "bold", fill: accent, title)
  v(0.05em)
}

#text(size: 22pt, weight: "bold", r.identity.name) \
#v(0.1em)
#text(fill: luma(60))[#(( r.identity.email, r.identity.phone, r.identity.location ) + r.identity.links).join("   ·   ")]

#v(0.4em)
#r.summary

#section("Skills")
#for g in r.skills [
  #text(weight: "semibold", g.group) #h(0.4em) #g.items.join(" · ") \
]

#section("Experience")
#for e in r.experience [
  #text(weight: "bold", e.employer) #h(0.4em) #text(fill: luma(60), e.location) #h(1fr) #text(fill: luma(60), e.start + " – " + e.end) \
  #text(weight: "semibold", e.title)
  #for b in e.bullets [- #b.text]
  #v(0.35em)
]

#section("Projects")
#for p in r.projects [
  #text(weight: "bold", p.name) — #p.detail
  #for b in p.bullets [- #b.text]
]

#section("Education")
#for ed in r.education [
  #text(weight: "bold", ed.school) #h(1fr) #text(fill: luma(60), ed.start + " – " + ed.end) \
  #ed.degree
]

#section("Certifications")
#for c in r.certifications [
  #c.name #h(1fr) #text(fill: luma(60), c.year) \
]
