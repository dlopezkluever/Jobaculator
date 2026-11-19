// PROTOTYPE resume template A, "Classic": serif, centred name, ruled small-caps headings.
// ATS rules (#6): single column, no tables or text boxes, contact in the body, no graphics, real text.
#let r = json(sys.inputs.at("data", default: "resume.json"))
#set document(title: r.identity.name + " Resume", author: r.identity.name)
#set page(paper: "us-letter", margin: (x: 0.75in, y: 0.65in))
#set text(font: "Libertinus Serif", size: 10.5pt, lang: "en")
#set par(justify: false, leading: 0.55em, spacing: 0.6em)
#set list(indent: 0.6em, body-indent: 0.5em, spacing: 0.45em)

#let section(title) = {
  v(0.7em)
  text(size: 11pt, weight: "bold", tracking: 0.06em, upper(title))
  v(-0.55em)
  line(length: 100%, stroke: 0.6pt)
  v(0.1em)
}
#let row(left, right) = [#left #h(1fr) #right]

#align(center)[
  #text(size: 20pt, weight: "bold", r.identity.name) \
  #v(0.15em)
  #(( r.identity.location, r.identity.phone, r.identity.email ) + r.identity.links).join("  |  ")
]

#section("Summary")
#r.summary

#section("Experience")
#for e in r.experience [
  #row(strong(e.title), e.start + " – " + e.end) \
  #row(emph(e.employer), emph(e.location))
  #for b in e.bullets [- #b.text]
  #v(0.25em)
]

#section("Projects")
#for p in r.projects [
  #strong(p.name), #p.detail
  #for b in p.bullets [- #b.text]
]

#section("Skills")
#for g in r.skills [
  #strong(g.group): #g.items.join(", ") \
]

#section("Education")
#for ed in r.education [
  #row(strong(ed.school), ed.start + " – " + ed.end) \
  #ed.degree
]

#section("Certifications")
#for c in r.certifications [
  #row(c.name, c.year) \
]
