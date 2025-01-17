/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const {Builder} = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
require("geckodriver");

const {executeScript} = require("./webdriver");
const {ensureFirefox} = require("./firefox_download");

// Firefox 57 seems to be the minimum to reliably run with WebDriver
// on certain system configurations like Debian 9, TravisCI.
const FIREFOX_VERSION = "57.0";

function runScript(firefoxPath, script, scriptArgs)
{
  const options = new firefox.Options().setBinary(firefoxPath);
  if (process.env.BROWSER_TEST_HEADLESS != "0")
    options.headless();
  const driver = new Builder()
        .forBrowser("firefox")
        .setFirefoxOptions(options)
        .build();

  return executeScript(driver, "Firefox", script, scriptArgs);
}

module.exports = function(script, scriptName, ...scriptArgs)
{
  return ensureFirefox(FIREFOX_VERSION)
    .then(firefoxPath =>
          runScript(firefoxPath, script, scriptArgs));
};
