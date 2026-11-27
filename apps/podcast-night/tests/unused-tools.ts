import type { IssueComments } from "../src/summary.js";
import type { JobTool } from "../src/jobtool.js";

function refuse(name: string): never {
  throw new Error(`${name} must not be called in this test`);
}

/** Tool 2, tool 3 and comment ports that fail the test when a tick calls them. */
export const unusedTail = {
  tool2: {
    submit: async () => refuse("tool2.submit"),
    poll: async () => refuse("tool2.poll"),
  } as JobTool<never, never>,
  tool3: {
    submit: async () => refuse("tool3.submit"),
    poll: async () => refuse("tool3.poll"),
  } as JobTool<never, never>,
  comments: {
    hasComment: async () => refuse("comments.hasComment"),
    post: async () => refuse("comments.post"),
  } as IssueComments,
};
