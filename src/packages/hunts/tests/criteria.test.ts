import { describe, expect, it } from "vitest";
import { type HuntInput, huntInputSchema } from "../criteria";

const none = { ideal: [], good: [], acceptable: [], unacceptable: [], anythingElseUnacceptable: false };

/** The PRD §15 example Hunt. */
function exampleHunt(): HuntInput {
	return {
		name: "AI / Software Engineering",
		criteria: {
			roles: {
				ideal: ["AI Engineer", "Applied AI Engineer"],
				good: ["Software Engineer", "Solutions Engineer"],
				acceptable: ["Developer Experience Engineer"],
				unacceptable: [],
				anythingElseUnacceptable: true,
			},
			locations: {
				ideal: ["San Francisco"],
				good: ["New York", "Washington DC"],
				acceptable: ["Remote US"],
				unacceptable: [],
				anythingElseUnacceptable: false,
			},
			payFloor: 100_000,
			experienceStretch: null,
		},
	};
}

function issues(input: unknown) {
	const result = huntInputSchema.safeParse(input);
	return result.success
		? []
		: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

describe("Hunt criteria shape", () => {
	it("accepts the PRD example, defaulting to AUTO submission and Aggressive Creative Latitude", () => {
		const parsed = huntInputSchema.parse(exampleHunt());
		expect(parsed.submissionPolicy).toBe("AUTO");
		expect(parsed.creativeLatitude).toBe("AGGRESSIVE");
		expect(parsed.criteria.roles.ideal).toEqual(["AI Engineer", "Applied AI Engineer"]);
	});

	it("trims values and the name, and refuses a blank one", () => {
		const hunt = exampleHunt();
		hunt.name = "  Writing  ";
		hunt.criteria.locations.ideal = ["  Austin "];
		const parsed = huntInputSchema.parse(hunt);
		expect([parsed.name, parsed.criteria.locations.ideal]).toEqual(["Writing", ["Austin"]]);

		hunt.name = "   ";
		hunt.criteria.locations.good = ["New York", " "];
		expect(issues(hunt).map((i) => i.path)).toEqual(["name", "criteria.locations.good.1"]);
	});

	it("refuses a value listed in two tiers, ignoring case, at the later tier", () => {
		const hunt = exampleHunt();
		hunt.criteria.roles.unacceptable = ["software engineer"];
		hunt.criteria.locations.acceptable = ["Remote US", "remote us"];
		expect(issues(hunt)).toEqual([
			{ path: "criteria.roles.unacceptable.0", message: '"software engineer" is already listed as Good' },
			{ path: "criteria.locations.acceptable.1", message: '"remote us" is already listed as Acceptable' },
		]);
	});

	it("needs at least one acceptable role, but lets locations stay unconstrained", () => {
		const hunt = exampleHunt();
		hunt.criteria.roles = { ...none, unacceptable: ["Intern"] };
		hunt.criteria.locations = none;
		expect(issues(hunt).map((i) => i.path)).toEqual(["criteria.roles.ideal"]);
	});

	it('refuses "anything else unacceptable" when nothing is listed as acceptable', () => {
		const hunt = exampleHunt();
		hunt.criteria.locations = { ...none, unacceptable: ["London"], anythingElseUnacceptable: true };
		expect(issues(hunt).map((i) => i.path)).toEqual(["criteria.locations.anythingElseUnacceptable"]);
		hunt.criteria.locations = { ...none, unacceptable: ["London"] };
		expect(issues(hunt)).toEqual([]);
	});

	it("takes a whole, positive pay floor in dollars, or none", () => {
		const withFloor = (payFloor: number | null) => {
			const hunt = exampleHunt();
			hunt.criteria.payFloor = payFloor;
			return issues(hunt).map((i) => i.path);
		};
		expect(withFloor(null)).toEqual([]);
		expect(withFloor(1)).toEqual([]);
		expect(withFloor(0)).toEqual(["criteria.payFloor"]);
		expect(withFloor(-50_000)).toEqual(["criteria.payFloor"]);
		expect(withFloor(99_999.5)).toEqual(["criteria.payFloor"]);
	});

	it("takes an experience-stretch override from 1× to 5×, or none for the default", () => {
		const withStretch = (experienceStretch: number | null) => {
			const hunt = exampleHunt();
			hunt.criteria.experienceStretch = experienceStretch;
			return issues(hunt).map((i) => i.path);
		};
		expect([withStretch(null), withStretch(1), withStretch(1.5), withStretch(5)]).toEqual([[], [], [], []]);
		expect(withStretch(0.5)).toEqual(["criteria.experienceStretch"]);
		expect(withStretch(6)).toEqual(["criteria.experienceStretch"]);
	});

	it("refuses unknown Creative Latitude levels and any policy but AUTO", () => {
		expect(issues({ ...exampleHunt(), creativeLatitude: "WILD" }).map((i) => i.path)).toEqual(["creativeLatitude"]);
		expect(issues({ ...exampleHunt(), submissionPolicy: "REVIEW" }).map((i) => i.path)).toEqual(["submissionPolicy"]);
	});

	it("refuses criteria missing a dimension", () => {
		const { locations: _, ...criteria } = exampleHunt().criteria;
		expect(issues({ ...exampleHunt(), criteria }).map((i) => i.path)).toEqual(["criteria.locations"]);
	});
});
