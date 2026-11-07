import {test} from "node:test";
import assert from "node:assert/strict";
import {pollUpdates} from "./ui/update-polling.mjs";

test("checks immediately and waits fifteen minutes after a slow request completes", async t => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let finish, calls = 0;
    const request = new Promise(resolve => {finish = resolve;});
    const stop = pollUpdates(() => {calls++;return request;}, assert.fail);
    assert.equal(calls, 1);
    t.mock.timers.tick(5000);
    finish();
    await request;
    t.mock.timers.tick(15 * 60 * 1000 - 1);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.equal(calls, 2);
    await request;
    stop();
    t.mock.timers.tick(15 * 60 * 1000);
    assert.equal(calls, 2);
});

test("stopping an in-flight check prevents overlap and any later timer", async t => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let finish, calls = 0;
    const request = new Promise(resolve => {finish = resolve;});
    const stop = pollUpdates(() => {calls++;return request;}, assert.fail);
    t.mock.timers.tick(30 * 60 * 1000);
    assert.equal(calls, 1);
    stop();
    finish();
    await request;
    t.mock.timers.tick(30 * 60 * 1000);
    assert.equal(calls, 1);
});

test("failed checks report the error and schedule the next fifteen-minute attempt", async t => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const errors = [];
    let calls = 0;
    const failure = new Error("offline");
    const stop = pollUpdates(() => {calls++;return Promise.reject(failure);}, error => errors.push(error));
    await Promise.resolve();
    assert.deepEqual(errors, [failure]);
    t.mock.timers.tick(15 * 60 * 1000 - 1);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.equal(calls, 2);
    await Promise.resolve();
    assert.deepEqual(errors, [failure, failure]);
    stop();
});
