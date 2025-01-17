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

/**
 * @fileOverview Element hiding implementation.
 */

const {elemHideExceptions} = require("./elemHideExceptions");
const {filterNotifier} = require("./filterNotifier");
const {normalizeHostname, domainSuffixes} = require("./url");
const {FiltersByDomain} = require("./filtersByDomain");
const {Cache} = require("./caching");

/**
 * The maximum number of selectors in a CSS rule. This is used by
 * <code>{@link createStyleSheet}</code> to split up a long list of selectors
 * into multiple rules.
 * @const {number}
 * @default
 */
const SELECTOR_GROUP_SIZE = 1024;

/**
 * {@link elemHide} implementation.
 */
class ElemHide
{
  /**
   * @hideconstructor
   */
  constructor()
  {
    /**
     * Lookup table, active flag, by filter by domain.
     * (Only contains filters that aren't unconditionally matched for all
     * domains.)
     * @type {FiltersByDomain}
     * @private
     */
    this._filtersByDomain = new FiltersByDomain();

    /**
     * Lookup table, filter by selector. (Only used for selectors that are
     * unconditionally matched for all domains.)
     * @type {Map.<string, Filter>}
     * @private
     */
    this._filterBySelector = new Map();

    /**
     * This array caches the keys of {@link ElemHide#_filterBySelector}
     * (selectors which unconditionally apply on all domains). It will be
     * <code>null</code> if the cache needs to be rebuilt.
     * @type {?Array.<string>}
     * @private
     */
    this._unconditionalSelectors = null;

    /**
     * The default style sheet that applies on all domains. This is based on the
     * value of <code>{@link ElemHide#_unconditionalSelectors}</code>.
     * @type {?string}
     * @private
     */
    this._defaultStyleSheet = null;

    /**
     * The common style sheet that applies on all unknown domains. This is a
     * concatenation of the default style sheet and an additional style sheet
     * based on selectors from all generic filters that are not in the
     * <code>{@link ElemHide#_unconditionalSelectors}</code> list.
     * @type {?string}
     * @private
     */
    this._commonStyleSheet = null;

    /**
     * Cache of generated domain-specific style sheets. This contains entries
     * for only known domains. If a domain is unknown, it gets
     * <code>{@link ElemHide#_commonStyleSheet}</code>.
     * @type {Cache.<string, string>}
     * @private
     */
    this._styleSheetCache = new Cache(100);

    /**
     * Set containing known element hiding filters
     * @type {Set.<ElemHideFilter>}
     * @private
     */
    this._filters = new Set();

    /**
     * All domains known to occur in exceptions
     * @type {Set.<string>}
     * @private
     */
    this._exceptionDomains = new Set();

    elemHideExceptions.on("added", this._onExceptionAdded.bind(this));
  }

  /**
   * Removes all known element hiding filters.
   */
  clear()
  {
    this._commonStyleSheet = null;

    for (let collection of [this._styleSheetCache, this._filtersByDomain,
                            this._filterBySelector, this._filters,
                            this._exceptionDomains])
    {
      collection.clear();
    }

    this._unconditionalSelectors = null;
    this._defaultStyleSheet = null;

    filterNotifier.emit("elemhideupdate");
  }

  /**
   * Add a new element hiding filter.
   * @param {ElemHideFilter} filter
   */
  add(filter)
  {
    if (this._filters.has(filter))
      return;

    this._styleSheetCache.clear();
    this._commonStyleSheet = null;

    let {domains, selector} = filter;

    if (!(domains || elemHideExceptions.hasExceptions(selector)))
    {
      // The new filter's selector is unconditionally applied to all domains
      this._filterBySelector.set(selector, filter);
      this._unconditionalSelectors = null;
      this._defaultStyleSheet = null;
    }
    else
    {
      // The new filter's selector only applies to some domains
      this._filtersByDomain.add(filter, domains);
    }

    this._filters.add(filter);
    filterNotifier.emit("elemhideupdate");
  }

  /**
   * Removes an existing element hiding filter.
   * @param {ElemHideFilter} filter
   */
  remove(filter)
  {
    if (!this._filters.has(filter))
      return;

    this._styleSheetCache.clear();
    this._commonStyleSheet = null;

    let {selector} = filter;

    // Unconditially applied element hiding filters
    if (this._filterBySelector.get(selector) == filter)
    {
      this._filterBySelector.delete(selector);
      this._unconditionalSelectors = null;
      this._defaultStyleSheet = null;
    }
    // Conditionally applied element hiding filters
    else
    {
      this._filtersByDomain.remove(filter);
    }

    this._filters.delete(filter);
    filterNotifier.emit("elemhideupdate");
  }

  /**
   * @typedef {object} ElemHideStyleSheet
   * @property {string} code CSS code.
   * @property {Array.<string>} selectors List of selectors.
   */

  /**
   * Generates a style sheet for a given domain based on the current set of
   * filters.
   *
   * @param {string} domain The domain.
   * @param {boolean} [specificOnly=false] Whether selectors from generic
   *   filters should be included.
   * @param {boolean} [includeSelectors=false] Whether the return value should
   *   include a separate list of selectors.
   * @param {boolean} [includeExceptions=false] Whether the return value should
   *   include a separate list of exceptions.
   *
   * @returns {ElemHideStyleSheet} An object containing the CSS code and the
   *   list of selectors.
   */
  generateStyleSheetForDomain(domain, specificOnly = false,
                              includeSelectors = false,
                              includeExceptions = false)
  {
    let code = null;
    let selectors = null;
    let exceptions = null;

    domain = normalizeHostname(domain);

    if (specificOnly)
    {
      if (includeExceptions)
      {
        let selectorsAndExceptions =
          this._getConditionalSelectorsWithExceptions(domain, true);

        selectors = selectorsAndExceptions.selectors;
        exceptions = selectorsAndExceptions.exceptions;
      }
      else
      {
        selectors = this._getConditionalSelectors(domain, true);
      }

      code = createStyleSheet(selectors);
    }
    else
    {
      let knownSuffix = this._getKnownSuffix(domain);

      if (includeSelectors || includeExceptions)
      {
        let selectorsAndExceptions =
          this._getConditionalSelectorsWithExceptions(knownSuffix, false);

        selectors = selectorsAndExceptions.selectors;
        exceptions = selectorsAndExceptions.exceptions;
        code = knownSuffix == "" ? this._getCommonStyleSheet() :
                 (this._getDefaultStyleSheet() + createStyleSheet(selectors));

        selectors = this._getUnconditionalSelectors().concat(selectors);
      }
      else
      {
        code = knownSuffix == "" ? this._getCommonStyleSheet() :
                 (this._getDefaultStyleSheet() +
                  this._getDomainSpecificStyleSheet(knownSuffix));
      }
    }

    return {
      code,
      selectors: includeSelectors ? selectors : null,
      exceptions: includeExceptions ? exceptions : null
    };
  }

  /**
   * Returns the suffix of the given domain that is known. If no suffix is
   * known, an empty string is returned.
   * @param {?string} domain
   * @returns {string}
   * @private
   */
  _getKnownSuffix(domain)
  {
    while (domain && !this._filtersByDomain.has(domain) &&
           !this._exceptionDomains.has(domain))
    {
      let index = domain.indexOf(".");
      domain = index == -1 ? "" : domain.substring(index + 1);
    }

    return domain;
  }

  /**
   * Returns a list of selectors that apply on each website unconditionally.
   * @returns {string[]}
   * @private
   */
  _getUnconditionalSelectors()
  {
    if (!this._unconditionalSelectors)
      this._unconditionalSelectors = [...this._filterBySelector.keys()];

    return this._unconditionalSelectors;
  }

  /**
   * Returns the list of selectors that apply on a given domain from the subset
   * of filters that do not apply unconditionally on all domains.
   *
   * @param {string} domain The domain.
   * @param {boolean} specificOnly Whether selectors from generic filters should
   *   be included.
   *
   * @returns {Array.<string>} The list of selectors.
   * @private
   */
  _getConditionalSelectors(domain, specificOnly)
  {
    let selectors = [];

    let excluded = new Set();

    for (let currentDomain of domainSuffixes(domain, !specificOnly))
    {
      let map = this._filtersByDomain.get(currentDomain);
      if (map)
      {
        for (let [filter, include] of map.entries())
        {
          if (!include)
          {
            excluded.add(filter);
          }
          else
          {
            let {selector} = filter;
            if ((excluded.size == 0 || !excluded.has(filter)) &&
                !elemHideExceptions.getException(selector, domain))
            {
              selectors.push(selector);
            }
          }
        }
      }
    }

    return selectors;
  }

  /**
   * Returns the list of selectors and the list of exceptions that apply on a
   * given domain from the subset of filters that do not apply unconditionally
   * on all domains.
   *
   * @param {string} domain The domain.
   * @param {boolean} specificOnly Whether selectors from generic filters should
   *   be included.
   *
   * @returns {{selectors: Array.<string>,
   *            exceptions: Array.<ElemHideException>}}
   *   An object containing the lists of selectors and exceptions.
   * @private
   */
  _getConditionalSelectorsWithExceptions(domain, specificOnly)
  {
    let selectors = [];
    let exceptions = [];

    let excluded = new Set();

    for (let currentDomain of domainSuffixes(domain, !specificOnly))
    {
      let map = this._filtersByDomain.get(currentDomain);
      if (map)
      {
        for (let [filter, include] of map.entries())
        {
          if (!include)
          {
            excluded.add(filter);
          }
          else if (excluded.size == 0 || !excluded.has(filter))
          {
            let {selector} = filter;
            let exception = elemHideExceptions.getException(selector, domain);

            if (exception)
              exceptions.push(exception);
            else
              selectors.push(selector);
          }
        }
      }
    }

    return {selectors, exceptions};
  }

  /**
   * Returns the default style sheet that applies on all domains.
   * @returns {string}
   * @private
   */
  _getDefaultStyleSheet()
  {
    if (!this._defaultStyleSheet)
    {
      this._defaultStyleSheet =
        createStyleSheet(this._getUnconditionalSelectors());
    }

    return this._defaultStyleSheet;
  }

  /**
   * Returns the common style sheet that applies on all unknown domains.
   * @returns {string}
   * @private
   */
  _getCommonStyleSheet()
  {
    if (!this._commonStyleSheet)
    {
      this._commonStyleSheet =
        this._getDefaultStyleSheet() +
        createStyleSheet(this._getConditionalSelectors("", false));
    }

    return this._commonStyleSheet;
  }

  /**
   * Returns the domain-specific style sheet that applies on a given domain.
   * @param {string} domain
   * @returns {string}
   * @private
   */
  _getDomainSpecificStyleSheet(domain)
  {
    let styleSheet = this._styleSheetCache.get(domain);

    if (typeof styleSheet == "undefined")
    {
      styleSheet =
        createStyleSheet(this._getConditionalSelectors(domain, false));
      this._styleSheetCache.set(domain, styleSheet);
    }

    return styleSheet;
  }

  _onExceptionAdded(exception)
  {
    let {domains, selector} = exception;

    this._styleSheetCache.clear();
    this._commonStyleSheet = null;

    if (domains)
    {
      for (let domain of domains.keys())
      {
        // Note: Once an exception domain is known it never becomes unknown,
        // even when all the exceptions containing that domain are removed.
        // This is a best-case optimization.
        if (domain != "")
          this._exceptionDomains.add(domain);
      }
    }

    // If this is the first exception for a previously unconditionally applied
    // element hiding selector we need to take care to update the lookups.
    let unconditionalFilterForSelector = this._filterBySelector.get(selector);
    if (unconditionalFilterForSelector)
    {
      this._filtersByDomain.add(unconditionalFilterForSelector);
      this._filterBySelector.delete(selector);
      this._unconditionalSelectors = null;
      this._defaultStyleSheet = null;
    }
  }
}

/**
 * Container for element hiding filters.
 * @type {ElemHide}
 */
let elemHide = new ElemHide();

exports.elemHide = elemHide;

/**
 * Yields rules from a style sheet returned by
 * <code>{@link createStyleSheet}</code>.
 *
 * @param {string} styleSheet A style sheet returned by
 *   <code>{@link createStyleSheet}</code>. If the given style sheet is
 *   <em>not</em> a value previously returned by a call to
 *   <code>{@link createStyleSheet}</code>, the behavior is undefined.
 * @yields {string} A rule from the given style sheet.
 */
function* rulesFromStyleSheet(styleSheet)
{
  let startIndex = 0;
  while (startIndex < styleSheet.length)
  {
    let ruleTerminatorIndex = styleSheet.indexOf("\n", startIndex);
    yield styleSheet.substring(startIndex, ruleTerminatorIndex);
    startIndex = ruleTerminatorIndex + 1;
  }
}

exports.rulesFromStyleSheet = rulesFromStyleSheet;

/**
 * Splits a list of selectors into groups determined by the value of
 * <code>{@link SELECTOR_GROUP_SIZE}</code>.
 *
 * @param {Array.<string>} selectors
 * @yields {Array.<string>}
 */
function* splitSelectors(selectors)
{
  // Chromium's Blink engine supports only up to 8,192 simple selectors, and
  // even fewer compound selectors, in a rule. The exact number of selectors
  // that would work depends on their sizes (e.g. "#foo .bar" has a size of 2).
  // Since we don't know the sizes of the selectors here, we simply split them
  // into groups of 1,024, based on the reasonable assumption that the average
  // selector won't have a size greater than 8. The alternative would be to
  // calculate the sizes of the selectors and divide them up accordingly, but
  // this approach is more efficient and has worked well in practice. In theory
  // this could still lead to some selectors not working on Chromium, but it is
  // highly unlikely.
  // See issue #6298 and https://crbug.com/804179
  for (let i = 0; i < selectors.length; i += SELECTOR_GROUP_SIZE)
    yield selectors.slice(i, i + SELECTOR_GROUP_SIZE);
}

/**
 * Escapes curly braces to prevent CSS rule injection.
 *
 * @param {string} selector
 * @returns {string}
 */
function escapeSelector(selector)
{
  return selector.replace("{", "\\7B ").replace("}", "\\7D ");
}

/**
 * Creates an element hiding CSS rule for a given list of selectors.
 *
 * @param {Array.<string>} selectors
 * @returns {string}
 */
function createRule(selectors)
{
  let rule = "";

  for (let i = 0; i < selectors.length - 1; i++)
    rule += escapeSelector(selectors[i]) + ", ";

  rule += escapeSelector(selectors[selectors.length - 1]) +
          " {display: none !important;}\n";

  return rule;
}

/**
 * Creates an element hiding CSS style sheet from a given list of selectors.
 * @param {Array.<string>} selectors
 * @returns {string}
 */
function createStyleSheet(selectors)
{
  let styleSheet = "";

  for (let selectorGroup of splitSelectors(selectors))
    styleSheet += createRule(selectorGroup);

  return styleSheet;
}

exports.createStyleSheet = createStyleSheet;
