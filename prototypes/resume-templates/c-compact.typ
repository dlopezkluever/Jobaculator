// PROTOTYPE resume template C, "Compact": dense, one line per role header, tight margins,
// built to keep a long history readable (two pages are fine per #16, this one tries to need fewer).
// ATS rules (#6): single column, no tables or text boxes, contact in the body, no graphics, real text.
#let r = json(sys.inputs.at("data", default: "resume.json"))
#set document(title: r.identity.name + " Resume", author: r.identity.name)
#set page(paper: "us-letter", margin: (x: 0.6in, y: 0.5in))
#set text(font: "New Computer Modern", size: 10pt, lang: "en")
#set par(justify: true, leading: 0.5em, spacing: 0.5em)
#set list(indent: 0.4em, body-indent: 0.4em, spacing: 0.38em)

#let section(title) = {
  v(0.55em)
  text(size: 10.5pt, weight: "bold", smallcaps(title))
  h(0.5em)
  box(width: 1fr, line(length: 100%, stroke: 0.4pt))
  v(0.15em)
}

#text(size: 16pt, weight: "bold", r.identity.name) #h(1fr) #r.identity.email · #r.identity.phone \
#r.identity.location #h(1fr) #r.identity.links.join(" · ")

#section("Summary")
#r.summary

#section("Experience")
#for e in r.experience [
  *#e.title*, #e.employer #h(0.3em) #text(size: 9pt)[· #e.location] #h(1fr) #e.start – #e.end
  #for b in e.bullets [- #b.text]
]

#section("Projects")
#for p in r.projects [
  *#p.name*: #p.detail. #p.bullets.map(b => b.text).join(" ")
]

#section("Skills")
#r.skills.map(g => [*#g.group:* #g.items.join(", ")]).join([ #h(0.6em) ])

#section("Education & Certifications")
#for ed in r.education [
  *#ed.degree*, #ed.school #h(1fr) #ed.start – #ed.end \
]
#for c in r.certifications [
  #c.name #h(1fr) #c.year \
]
