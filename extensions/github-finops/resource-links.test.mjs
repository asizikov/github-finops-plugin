import {test} from "node:test";
import assert from "node:assert/strict";
import {budgetEntityLink, enterpriseTeamUrl, organizationUrl, repositoryUrl, resourceLink, trustedEnterpriseTeamUrl} from "./ui/resource-links.mjs";

const target = {host: "github.com", enterprise: "example-enterprise"};

test("builds typed HTTPS GitHub URLs on the configured host", () => {
    assert.equal(organizationUrl("github.com", "octo-org"), "https://github.com/octo-org");
    assert.equal(organizationUrl("Tenant.GHE.com", "octo-org"), "https://tenant.ghe.com/octo-org");
    assert.equal(repositoryUrl("github.com", "octo-org/hello.world"), "https://github.com/octo-org/hello.world");
    assert.equal(enterpriseTeamUrl("tenant.ghe.com", "example-enterprise", "platform-team"),
        "https://tenant.ghe.com/enterprises/example-enterprise/teams/platform-team");
    assert.deepEqual(resourceLink("Org", "octo-org", target), {kind: "external", type: "organization", href: "https://github.com/octo-org"});
    assert.deepEqual(resourceLink("Repo", "octo-org/app", target), {kind: "external", type: "repository", href: "https://github.com/octo-org/app"});
    assert.deepEqual(resourceLink("Team", "platform", target),
        {kind: "external", type: "team", href: "https://github.com/enterprises/example-enterprise/teams/platform"});
});

test("users route in-app instead of to an external profile", () => {
    assert.deepEqual(resourceLink("User", "Mona_Octo", target), {kind: "user", login: "mona_octo"});
    assert.deepEqual(budgetEntityLink({scope: "user", user: "octocat", entity: null}, target), {kind: "user", login: "octocat"});
    assert.equal(resourceLink("User", "@octocat", target), null);
    assert.equal(resourceLink("User", "https://github.com/octocat", target), null);
});

test("refuses malformed, incomplete or untrusted values instead of inventing links", () => {
    for (const [type, name] of [
        ["Org", "../evil"], ["Org", "octo org"], ["Org", "-bad"], ["Org", ""], ["Org", null],
        ["Repo", "only-a-name"], ["Repo", "octo-org/.."], ["Repo", "a/b/c"], ["Repo", "octo-org/app?x=1"],
        ["Team", "ent:platform"], ["Team", "Platform Team"], ["Team", "a/b"],
        ["Unknown", "octo-org"], ["Organization", "4f0c2a5e-1234-4abc-9def-0123456789ab-extra-long-uuid-like"],
    ]) assert.equal(resourceLink(type, name, target), null, `${type} ${name}`);
    assert.equal(organizationUrl("evil.example", "octo-org"), null);
    assert.equal(organizationUrl("github.com.evil.example", "octo-org"), null);
    assert.equal(resourceLink("Team", "platform", {host: "github.com"}), null);
    assert.equal(budgetEntityLink({scope: "repository", entity: "app"}, target), null);
    assert.equal(budgetEntityLink({scope: "enterprise", entity: "example-enterprise"}, target), null);
    assert.equal(budgetEntityLink({scope: "cost_center", entity: "octo-org"}, target), null);
    assert.deepEqual(budgetEntityLink({scope: "organization", entity: "octo-org"}, target),
        {kind: "external", type: "organization", href: "https://github.com/octo-org"});
});

test("accepts API team html_url only for HTTPS enterprise team pages on the configured host", () => {
    const href = "https://github.com/enterprises/example-enterprise/teams/platform";
    assert.equal(trustedEnterpriseTeamUrl("github.com", href), href);
    for (const value of [
        "http://github.com/enterprises/example-enterprise/teams/platform",
        "https://evil.example/enterprises/example-enterprise/teams/platform",
        "https://user:pass@github.com/enterprises/example-enterprise/teams/platform",
        "https://github.com/orgs/example/teams/platform",
        "https://github.com/enterprises/example-enterprise/teams/platform?next=x",
        "javascript:alert(1)", "not a url", null,
    ]) assert.equal(trustedEnterpriseTeamUrl("github.com", value), null, String(value));
});
