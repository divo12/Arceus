#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import meow from "meow";
import { setBaseUrl } from "./api/client.js";
import { App } from "./app.js";

const cli = meow(
  `
  Usage
    $ arceus-tui [options]

  Options
    --api-url, -u   API base URL (default: http://localhost:4000)
    --help          Show this help

  Examples
    $ arceus-tui
    $ arceus-tui --api-url http://localhost:4000
`,
  {
    importMeta: import.meta,
    flags: {
      apiUrl: {
        type: "string",
        shortFlag: "u",
        default: "http://localhost:4000",
      },
    },
  },
);

setBaseUrl(cli.flags.apiUrl);

render(<App />);
