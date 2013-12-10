/**
 * @fileoverview Google CLA Verifier for GitHub
 * @author Igor Minar (igor@angularjs.org)
 * @copyright (c) 2013 Google, Inc
 * @license MIT
 * @version 1.1.1
 * @description
 *
 * This Google App Script app that automatically verifies whether PRs in a given project where authored by developers who signed
 * Google's CLA via the online form (http://code.google.com/legal/individual-cla-v1.0.html).
 *
 * The association between the developer and CLA signer is done by matching email in the PR commit against email in the CLA spreadsheet.
 *
 * Features
 * --------
 * - retrieves all open PRs from a github repo and checks their CLA status
 * - adds "cla: yes" or "cla: no" label to all open PRs
 * - supports cron-like scheduling via App Script triggers
 * - emails log output to the person who installs this script after each run
 *
 *
 * Instalation
 * ------------
 *
 * 1/ App Script Project
 *
 * Start a new "blank project" at http://script.google.com under your @google.com account.
 *
 * Create a new file "cla-verifier.gs" in there and copy the conents of this file there.
 *
 *
 * 2/ ENV Variables
 *
 * This script assumes that there is another .gs file in the same project which defines GITHUB_REPO and GITHUB_ACCESS_TOKEN variables.
 * The filename is not significant. Example:

   var GITHUB_ACCESS_TOKEN = '12345'; //"Personal Token" string generated via https://github.com/settings/applications
   var GITHUB_REPO = 'angular/angular.js';
   var CLA_NOT_FOUND_COMMENT = 'Please sign CLA at http://code.google.com/legal/individual-cla-v1.0.html';
   var THANKS_FOR_SIGNING_CLA_COMMENT = 'Achievement unlocked: CLA signature found!';

 *
 * 3/ GitHub Labels
 *
 * In the project to be monitored create two labels:
 * - "cla: yes"
 * - "cla: no"
 *
 *
 * 4/ App Script Project Trigger
 *
 * Set up a project trigger that will run the "checkCla" function once an hour (or once a day).
 *
 *
 * 5/ GitHub PR Helper Chrome Extension
 *
 * Since GitHub's UI doesn't show labels for PRs, install [GitHub PR Helper](https://github.com/petebacondarwin/github-pr-helper)
 * Chrome Extension to make the labels visible in the PR/Issues list and detail views.
 *
 *
 * Limitations
 * -----------
 * - doesn't check corporate signers
 * - retrieves email only from the first commit in the PR
 * - there are no unit or end-to-end tests for this code (I have yet to figure out a way to test app script code)
 *
 *
 * Development / Improvements
 * --------------------------
 *
 * The code is hosted at https://github.com/angular/google-cla-verifier-for-github
 *
 * Changelog: https://github.com/angular/google-cla-verifier-for-github/commits/master
 */

function checkCla() {
  if (!CLA_NOT_FOUND_COMMENT) throw new Error('CLA_NOT_FOUND_COMMENT env variable not found');
  if (!THANKS_FOR_SIGNING_CLA_COMMENT) throw new Error('THANKS_FOR_SIGNING_CLA_COMMENT env variable not found');

  log('Starting CLA check');
  var start = Date.now();
  var newClaPrs = [];

  log('Initiating GitHub Client');
  var github = new GitHub();

  var prsToVerify = github.getPrsWithNoCla();

  if (prsToVerify.length) {
    log('Initiating ClaRepo');
    var claRepo = new ClaRepo();

    log('Verifying CLA for PRs');
    prsToVerify.forEach(function (prNumber) {
      var email = github.getEmailForPr(prNumber);

      log("  -> PR #%s - email: %s", prNumber, email);

      if (claRepo.containsEmail(email)) {
        log("    ->> CLA found!");
        if (!github.isLabeledAsClaNo(prNumber)) {
          log("    ->> This PR was previously checked and didn't have CLA, posting a 'thank you' comment");
          github.postComment(prNumber, THANKS_FOR_SIGNING_CLA_COMMENT);
        }
        log("   ->> Applying CLA label to the PR");
        github.labelPrAsClaYes(prNumber);
        newClaPrs.push(prNumber);
      } else {
        if (!github.isLabeledAsClaNo(prNumber)) {
          log("   ->> CLA not found, posting CLA request comment", prNumber);
          github.postComment(prNumber, CLA_NOT_FOUND_COMMENT);
        }
        github.labelPrAsClaNo(prNumber);
      }
    });
  }

  var end = Date.now();
  log("Finished CLA Check (took: %sms | verified %s PRs | found %s new CLAs)", (end - start), prsToVerify.length, newClaPrs.length);

  emailLog(newClaPrs.length, (prsToVerify.length - newClaPrs.length));
}


function GitHub() {
  if (!GITHUB_REPO) throw new Error('GITHUB_REPO env variable not found');
  if (!GITHUB_ACCESS_TOKEN) throw new Error('GITHUB_ACCESS_TOKEN env variable not found');

  var PRS_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/pulls?access_token=' + GITHUB_ACCESS_TOKEN + '&state=open\&page=';
  var PR_LABEL_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/issues/ISSUE_NUMBER/labels?access_token=' + GITHUB_ACCESS_TOKEN;
  var ISSUE_COMMENT_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/issues/ISSUE_NUMBER/comments?access_token=' + GITHUB_ACCESS_TOKEN;
  var CLA_NO_LABEL = 'cla: no';
  var CLA_YES_LABEL = 'cla: yes';

  var openPrs = fetchOpenPrs();
  var openPrsMap = prArrayToMap(openPrs);
  var labelsCache = {};

  this.getPrsWithNoCla = getPrsWithNoCla;
  this.getEmailForPr = getEmailForPr;
  this.getLabelsForPr = getLabelsForPr;
  this.labelPrAsClaYes = labelPrAsClaYes;
  this.labelPrAsClaNo = labelPrAsClaNo;
  this.isLabeledAsClaNo = isLabeledAsClaNo;
  this.postComment = postComment;



  function fetchOpenPrs() {
    var response = UrlFetchApp.fetch(prPageUrl(1));

    var linkHeader = response.getHeaders()['Link'];
    var numberOfPages = parseInt(linkHeader.match(/page=(\d+)>; rel="last"/)[1], 10);
    log('  -> Determined that there are %s pages of open PRs', numberOfPages);

    var allPrs  = [];
    var allPrsMap = {};

    var page = Utilities.jsonParse(response.getContentText());
    allPrs = allPrs.concat(page);

    for (var i = 2; i <= numberOfPages; i++) {
      response = UrlFetchApp.fetch(prPageUrl(i));
      page = Utilities.jsonParse(response.getContentText());
      allPrs = allPrs.concat(page);
    }

    log('  -> Fetched PR info for %s PRs', allPrs.length);

    return allPrs;
  }


  function prArrayToMap(prs) {
    return prs.reduce(function(map, pr) { map[pr['number']] = pr; return map}, {});
  }


  function getPrsWithNoCla() {
    return openPrs.reduce(function(noClaPrs, pr) {
      var prNumber = pr['number'];
      var labels = getLabelsForPr(prNumber);

      // if PR state is "No CLA"
      if (labels.indexOf(CLA_NO_LABEL) >= 0 || labels.indexOf(CLA_YES_LABEL) === -1) {
        log('  -> PR #%s is missing CLA', prNumber);
        noClaPrs.push(prNumber);
      }

      return noClaPrs;
    }, []);
  }


  function getEmailForPr(prNumber) {
    var patchUrl = openPrsMap[prNumber]['patch_url'];
    var response = UrlFetchApp.fetch(patchUrl).getContentText();
    var email = response.match(/^From: .* <(\S+@\S+)>$/m)[1];
    return email;
  }


  function getLabelsForPr(prNumber) {
    var labels = labelsCache[prNumber];
    if (labels) return labels;

    var response = UrlFetchApp.fetch(prLabelsUrl(prNumber));
    labels = Utilities.jsonParse(response.getContentText()).
                       map(function(labelInfo) {return labelInfo.name; });

    labelsCache[prNumber] = labels;

    return labels;
  }


  function labelPrAsClaYes(prNumber) {
    UrlFetchApp.fetch(prLabelsUrl(prNumber), {method: 'POST', payload: Utilities.jsonStringify([CLA_YES_LABEL])});
    UrlFetchApp.fetch(prLabelUrl(prNumber, CLA_NO_LABEL), {method: 'DELETE'});
  }


  function labelPrAsClaNo(prNumber) {
    UrlFetchApp.fetch(prLabelsUrl(prNumber), {method: 'POST', payload: Utilities.jsonStringify([CLA_NO_LABEL])});
    UrlFetchApp.fetch(prLabelUrl(prNumber, CLA_YES_LABEL), {method: 'DELETE'});
  }


  function isLabeledAsClaNo(prNumber) {
    return getLabelsForPr(prNumber).indexOf(CLA_NO_LABEL) >= 0;
  }


  function postComment(issueNumber, text) {
    UrlFetchApp.fetch(issueCommentUrl(issueNumber), {method: 'POST', payload: Utilities.jsonStringify({body: text})});
  }


  function prPageUrl(page) {
    return PRS_URL + page;
  }


  function prLabelsUrl(prNumber) {
    return PR_LABEL_URL.replace('ISSUE_NUMBER', prNumber);
  }


  function prLabelUrl(prNumber, label) {
    var escapedLabel = label.replace(':', '%3A').replace(/\s/, '+');
    return PR_LABEL_URL.replace('ISSUE_NUMBER', prNumber).replace('?', '/' + escapedLabel + '?');
  }


  function issueCommentUrl(issueNumber) {
    return ISSUE_COMMENT_URL.replace('ISSUE_NUMBER', issueNumber);
  }
}


function ClaRepo() {
  var claSpreadSheet = SpreadsheetApp.openByUrl('https://docs.google.com/a/google.com/spreadsheet/ccc?key=0AjutNIkpUHk2cDlpTnlzRmo0M3VEdFVQZVJyS3ZHTlE');
  var sheet = claSpreadSheet.getSheetByName("Individual Signers");

  var rangeWithEmails = sheet.getRange(2, 4, sheet.getLastRow());
  var valuesWithEmails = rangeWithEmails.getValues();
  var emails = [];

  for (var i = 0; i < valuesWithEmails.length; i++) {
    var email = valuesWithEmails[i][0];
    emails.push(email);
  }

  this.containsEmail = function(email) {
    var spreadsheetRowIndex = emails.indexOf(email) + 2; // +1 because first row is header and +1 because the rows are 1-based

    if (spreadsheetRowIndex >= 2) {
      log('   ->> Found signature: %s (spreadsheet index: %s)', email, spreadsheetRowIndex);
      return true;
    }
  }
}


/**
 * serializes all msg variables into a pretty string and passes them onto the default Logger.log(
 *
 * @param {string} message Message format with %s as placeholders
 * @param {*...} msgVariables
 */
function log(message) {
  var args = [message];
  var arg;

  for (var i = 1, l = arguments.length; i <= l; i++) {
    arg = arguments[i];

    switch (typeof arg) {
      case 'string': break;
      case 'number': arg = arg.toString();
                     break;
      default: arg = Utilities.jsonStringify(arg);
    }

    args.push(arg);
  }

  Logger.log.apply(Logger, args);
}


function emailLog(newClaCount, claMissingCount) {
 var recipient = Session.getActiveUser().getEmail();
 var subject = 'Google CLA Verifier Log (newly signed: ' + newClaCount + ', still missing: ' + claMissingCount + ')';
 var body = Logger.getLog();
 MailApp.sendEmail(recipient, subject, body);
}
