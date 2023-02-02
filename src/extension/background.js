/*
 * Copyright 2021 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

'use strict';

import {
    GH_URL,
    SHARE_PREFIX,
    DEV_URL,
    MANIFEST,
    log,
    i18n,
    checkLastError,
    getState,
    getProjectMatches,
    toggleDisplay,
    getProject,
    addProject,
    setProject,
    deleteProject,
    getShareSettings,
    getGitHubSettings,
    setConfig,
    getConfig,
    storeAuthToken,
    updateProjectConfigs,
} from './utils.js';

/**
 * Tries to retrieve a project config from a tab.
 * @param string} tabUrl The URL of the tab
 * @returns {object} The config object
 */
function getConfigFromTabUrl(tabUrl) {
    if (!tabUrl) {
        return {};
    }
    const cfg = getShareSettings(tabUrl);
    if (!cfg.giturl) {
        if (tabUrl.startsWith(GH_URL)) {
            cfg.giturl = tabUrl;
        } else {
            try {
                const url = new URL(tabUrl);
                const res = /(.*)--(.*)--(.*)\.hlx\.[page|live]/.exec(url.hostname);
                if (res && res.length === 4) {
                    cfg.giturl = `${GH_URL}${res[3]}/${res[2]}/tree/${res[1]}`;
                }
            } catch (e) {
                // ignore invalid url
            }
        }
    }
    return cfg;
}

/**
 * Retrieves the proxy URL from a local dev tab.
 * @param {chrome.tabs.Tab} tab The tab
 * @returns {Promise} The proxy URL
 */
async function getProxyUrl({id, url: tabUrl}) {
    if (tabUrl.startsWith(DEV_URL)) {
        return new Promise((resolve) => {
            // inject proxy url retriever
            chrome.scripting.executeScript({
                target: {tabId: id},
                func: () => {
                    let proxyUrl = null;
                    const meta = document.head.querySelector('meta[property="hlx:proxyUrl"]');
                    if (meta && meta.content) {
                        proxyUrl = meta.content;
                    }
                    chrome.runtime.sendMessage({proxyUrl});
                },
            });
            // listen for proxy url from tab
            const listener = ({proxyUrl: proxyUrlFromTab}, {tab}) => {
                // check if message contains proxy url and is sent from right tab
                if (proxyUrlFromTab && tab && tab.url === tabUrl && tab.id === id) {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve(proxyUrlFromTab);
                } else {
                    // fall back to tab url
                    resolve(tabUrl);
                }
            };
            chrome.runtime.onMessage.addListener(listener);
        });
    } else {
        return tabUrl;
    }
}

/**
 * Tries to guess if the current tab is a Franklin site.
 * @param {Object} The tab
 * @returns {Promise<Boolean>} True if the provided tab is a Franklin site
 */
async function guessIfFranklinSite({id}) {
    return new Promise((resolve) => {
        chrome.scripting.executeScript({
            target: {tabId: id},
            func: () => {
                const isFranklinSite = document.head.querySelectorAll('script[src*="scripts.js"]').length > 0
                    && document.head.querySelectorAll('link[href*="styles.css"]').length > 0
                    && document.body.querySelector('main > div.section') !== null;
                chrome.runtime.sendMessage({isFranklinSite});
            },
        });
        // listen for response message from tab
        const listener = ({isFranklinSite}) => {
            // chrome.runtime.onMessage.removeListener(listener);
            resolve(isFranklinSite);
        };
        chrome.runtime.onMessage.addListener(listener);
    });
}

/**
 * Enables or disables context menu items for a tab.
 * @param {Object} tab The tab
 * @param {Object[]} configs The existing configurations
 */
async function checkContextMenu({url: tabUrl, id}, configs = []) {
    if (chrome.contextMenus) {
        // clear context menu
        chrome.contextMenus.removeAll(() => {
            // check if add project is applicable
      if (configs && !checkLastError()) {
                const {giturl} = getConfigFromTabUrl(tabUrl);
                if (giturl) {
                    const {owner, repo} = getGitHubSettings(giturl);
                    const config = configs.find((c) => c.owner === owner && c.repo === repo);
                    // add context menu item for adding/removing project config
                    chrome.contextMenus.create({
                        id: 'addRemoveProject',
                        title: config ? i18n('config_project_remove') : i18n('config_project_add'),
                        contexts: [
                            'action',
                        ],
                    });
                    if (config) {
                        // add context menu item for enabling/disabling project config
                        const {disabled} = config;
                        chrome.contextMenus.create({
                            id: 'enableDisableProject',
                            title: disabled ? i18n('config_project_enable') : i18n('config_project_disable'),
                            contexts: [
                                'action',
                            ],
                        });
                    }
                }
            }

            // add the open view doc context menu item only if the current tab is a Franklin site (guess)
            guessIfFranklinSite({id}).then((isFranklinSite) => {
                if (isFranklinSite) {
                    chrome.contextMenus.create({
                        id: 'openViewDocSource',
                        title: i18n('open_view_doc_source'),
                        contexts: [
                            'action',
                        ],
                    });
                }
            });
        });
    }
}

/**
 * Checks a tab and enables/disables the extension.
 * @param {number} id The ID of the tab
 */
function checkTab(id) {
    getState(({projects = []}) => {
        chrome.tabs.get(id, async (tab = {}) => {
            checkLastError();
            if (!tab.url) return;
            let checkUrl = tab.url;
            // check if active tab has a local dev URL
            if (checkUrl.startsWith(DEV_URL)) {
                // retrieve proxy url
                log.debug('local dev url detected, retrieve proxy url');
                checkUrl = await getProxyUrl(tab);
            }
            if (tab.active) {
                checkContextMenu(tab, projects);
            }
            if (new URL(checkUrl).pathname === SHARE_PREFIX) {
        log.debug('share url detected, inject install helper');
                try {
                    // instrument generator page
                    chrome.scripting.executeScript({
                        target: {tabId: id},
                        files: ['./installhelper.js'],
                    });
                } catch (e) {
                    log.error('error instrumenting generator page', id, e);
                }

            }
            const matches = await getProjectMatches(projects, checkUrl);
            log.debug('checking', id, checkUrl, matches);
                try {
                    // execute content script
                    chrome.scripting.executeScript({
                        target: {tabId: id},
                        files: ['./content.js'],
                    }, () => {
                        // send config matches to tab
                        chrome.tabs.sendMessage(id, {
                            projectMatches: matches,
                        });
                    });
                } catch (e) {
                    log.error('error enabling extension', id, e);
                }
        });
    });
}

/**
 * Toggles the extension for a tab.
 * @param {number} id The ID of the tab
 */
function toggle(id) {
    toggleDisplay(() => {
        checkTab(id);
    });
}

/**
 * Updates the help content according to the browser language
 * while respecting previous user acknowledgements.
 */
async function updateHelpContent() {
    const hlxSidekickHelpContent = await getConfig('sync', 'hlxSidekickHelpContent') || [];
    log.debug('existing help content', hlxSidekickHelpContent);
    const lang = navigator.language.startsWith('en') ? '' : `/${navigator.language.split('-')[0]}`;
    const resp = await fetch(`https://www.hlx.live${lang}/tools/sidekick/help.json`);
    if (resp.ok) {
        try {
            const [major, minor, patch] = MANIFEST.version.split('.');
            const json = await resp.json();
            const incomingTopics = (json['help-topics'] && json['help-topics'].data) || [];
            const incomingSteps = (json['help-steps'] && json['help-steps'].data) || [];
            const updatedHelpContent = incomingTopics
                .filter((incoming) => {
                    // filter topics by target version
                    const {targetVersion} = incoming;
                    if (targetVersion) {
                        const [targetMajor, targetMinor, targetPatch] = targetVersion.split('.');
                        if ((targetMajor && +major < +targetMajor)
                            || (targetMinor && +minor < +targetMinor)
                            || (targetPatch && +patch < +targetPatch)) {
                            return false;
                        }
                    }
                    return true;
                })
                .map((incoming) => {
                    const index = hlxSidekickHelpContent.findIndex((existing) => existing.id === incoming.id);
                    return {
                        ...(index >= 0 ? hlxSidekickHelpContent[index] : {}),
                        ...incoming,
                        steps: incoming.steps
                            .split(',')
                            .map((id) => id.trim())
                            .map((id) => incomingSteps.find((step) => step.id === id)),
                    };
                });
            log.info('updated help content', updatedHelpContent);
            await setConfig('sync', {
                hlxSidekickHelpContent: updatedHelpContent,
            });
        } catch (e) {
            log.error('failed to update help content', e);
        }
    }
}

/**
 * Open the view document source popup
 * @param {String} id The tab id
 */
function openViewDocSource(id) {
    chrome.windows.create({
        url: chrome.runtime.getURL(`/view-doc-source/index.html?tabId=${id}`),
        type: 'popup',
        width: 740,
    });
}

/**
 * Checks if the view document source popup needs to be openeded, and opens it if necessary.
 * @param {*} id The tab ID
 */
function checkViewDocSource(id) {
    chrome.tabs.get(id, (tab = {}) => {
        if (!tab.url || !tab.active) return;
        try {
            const u = new URL(tab.url);
            const vds = u.searchParams.get('view-doc-source');
            if (vds && vds === 'true') {
                openViewDocSource(id);
            }
        } catch (e) {
            log.warn(`Error checking view source for url: ${tab.url}`, e);
        }
    });
}

/**
 * Adds the listeners for the extension.
 */
(() => {
    chrome.runtime.onInstalled.addListener(async ({reason}) => {
        log.info(`sidekick extension installed (${reason})`);
        await updateHelpContent();
        await updateProjectConfigs();
    });

    // register message listener
    chrome.runtime.onMessageExternal.addListener(async (message, sender, sendResponse) => {
        log.info('sidekick got external message', message);
        const {owner, repo, authToken} = message;
        await storeAuthToken(owner, repo, authToken);
        // inform caller to close the window
        await sendResponse('close');
    });

    // actions for context menu items and install helper
    const actions = {
        addRemoveProject: async ({id, url}) => {
            const cfg = getConfigFromTabUrl(url);
            if (cfg.giturl) {
                getState(async ({projects = []}) => {
                    const {owner, repo} = getGitHubSettings(cfg.giturl);
                    const project = projects.find((p) => p.owner === owner && p.repo === repo);
                    if (!project) {
                        await addProject(cfg);
                    } else {
                        await deleteProject(`${owner}/${repo}`);
                    }
                    chrome.tabs.reload(id, {bypassCache: true});
                });
            }
        },
        enableDisableProject: async ({id, url}) => {
            const cfg = getConfigFromTabUrl(url);
            if (cfg.giturl) {
                const project = await getProject(getGitHubSettings(cfg.giturl));
                if (project) {
                    project.disabled = !project.disabled;
                    await setProject(project);
                    chrome.tabs.reload(id, {bypassCache: true});
                }
            }
        },
        openViewDocSource: async ({id}) => openViewDocSource(id),
    };

    if (chrome.contextMenus) {
        // add listener for clicks on context menu item
        chrome.contextMenus.onClicked.addListener(async ({menuItemId}, tab) => {
            if (!tab.url) return;
            actions[menuItemId](tab);
        });
    }

    // toggle the sidekick when the browser action is clicked
    chrome.action.onClicked.addListener(({id}) => {
        toggle(id);
    });

    // listen for url updates in any tab and inject sidekick if must be shown
    chrome.tabs.onUpdated.addListener((id, info) => {
        // wait until the tab is done loading
        if (info.status === 'complete') {
            checkTab(id);
            checkViewDocSource(id, true);
        }
    });

    // re-check tabs when activated
    chrome.tabs.onActivated.addListener(({tabId: id}) => {
        checkTab(id);
    });

    // detect and propagate display changes
    chrome.storage.onChanged.addListener(({hlxSidekickDisplay = null}, area) => {
        if (area === 'local' && hlxSidekickDisplay) {
            const display = hlxSidekickDisplay.newValue;
            log.info(`sidekick now ${display ? 'shown' : 'hidden'}`);
        }
    });

    // listen for add/remove project calls from the install helper
    chrome.runtime.onMessage.addListener(({action: actionFromTab}, {tab}) => {
        // check if message contains action and is sent from right tab
        if (tab && tab.url && new URL(tab.url).pathname.startsWith(SHARE_PREFIX)
            && actionFromTab && typeof actions[actionFromTab] === 'function') {
            actions[actionFromTab](tab);
        }
    });
})();

// announce sidekick display state
getState(({display}) => {
    log.info(`sidekick now ${display ? 'shown' : 'hidden'}`);
});

//const CLIENT_ID = encodeURIComponent("307f6e6136618df12528");
const CLIENT_ID = encodeURIComponent("7f57ca41ae308a1e499c");  // UPDATE GIT CLIENT ID
const REDIRECT_URI = chrome.identity.getRedirectURL();
let user_signed_in = false;
let ACCESS_TOKEN = '';

function create_auth_endpoint() {
    let oauth2_url = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=repo,gist,admin`;
    log.info(oauth2_url);
    return oauth2_url;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.message.data.includes('login')) {
        let siteName = '';
        log.info('SiteName : ' + request.message.siteName);
        siteName = request.message.siteName;
        log.info('templateid : ' + request.message.templateId);
        let templateId = request.message.templateId;
        oneclicksample(siteName, templateId);

    }
    return true;
});

async function oneclicksample(siteName, templateId) {

    try {
        log.info('Authorizing Github account');
        sendStatusMessage("Setting Up Git Repo ...", 0)
        sendStatusMessage("Setting Up Git Repo ...", 1)
        let git_auth_token = await getGitHubAuth();
        let git_access_token = await get_access_token(git_auth_token);
        sendStatusMessage("Setting Up Git Repo ...", 15)
        const gitData = await create_user_repo(siteName, git_access_token);
        sendStatusMessage("Git repo successfully created", 33);
        const giturl = gitData['url'];
        const gitcloneUrl = gitData['clone_url'];
        log.info(' Authorizing google account')
        sendStatusMessage("Setting up Google Drive folder...", 40);
        await get_gauth();
        const folderId = await createFolder(siteName);
        sendStatusMessage("Google Drive folder created successfully", 50);
        sendStatusMessage("Giving Permission to Google Drive", 53);
        await createPermission(folderId);
        sendStatusMessage("Giving Permission to Google Drive", 60);
        sendStatusMessage("Updating FsTab", 65);
        await editFsTab(giturl, git_access_token, folderId);
        sendStatusMessage("Adding Templates", 75);
        await addTemplate(templateId, folderId);
        sendStatusMessage("Templates Added Templates", 85);
        sendStatusMessage("Setup Helix Bot", 90);
        await installHelixbot();
        sendStatusMessage("Helix Bot added successfully", 95);
        sendStatusMessage("Project setup completed !", 100);
        publish(gitcloneUrl);
    } catch (e) {
        sendStatusMessage("Failed to create Franklin Project \n"+ e.message, 0);
    }
}

function sendStatusMessage(statusMessage, percentCompletion) {
    chrome.runtime.sendMessage({
        message:{
            data:"statusUpdate"
        } ,
        statusMessage: statusMessage,
        percentCompletion: percentCompletion
    })
}

async function getGitHubAuth() {
    let git_auth_token = '';
    log.info(`fetching Github AuthCode from${create_auth_endpoint()}`);
    const redirectUrl = await chrome.identity.launchWebAuthFlow({
        url: create_auth_endpoint(),
        interactive: true,
    });
        if (redirectUrl.includes('error=access_denied')) {
            let errormsg=" Access denied !";
            throw Error ("Failed to Authorize Git : "+errormsg);
        } else {
            git_auth_token = redirectUrl.substring(redirectUrl.indexOf('code=') + 5);
            setTimeout(() => {
                git_auth_token = '';
                user_signed_in = false;
            }, 3600000);
            log.info(`GitHub AuthCode is ${git_auth_token}`)
        }

    return git_auth_token;
}


async function get_access_token(gitAuthToken) {
    let getaccesstokenurl = `https://github.com/login/oauth/access_token`;
    log.info(`Fetching access token from ${getaccesstokenurl}`);
    // let bodyjson=`{"client_id": "${CLIENT_ID}","client_secret": "5bacc1a62ded3a19f630b907458e51d3ecdf100f","code": "${git_access_token}"}`;
    let bodyjson = JSON.stringify({
        client_id: CLIENT_ID,
        // client_secret: '5bacc1a62ded3a19f630b907458e51d3ecdf100f', // Update git Secret
        client_secret: '576d72f19970fc1c2f495f27181663342d6b5781',
        code: gitAuthToken
    });
    log.info(bodyjson);
    let response = await fetch(getaccesstokenurl, {
        method: 'POST',
        headers: {Authentication: gitAuthToken, 'Content-Type': 'application/json'},
        body: bodyjson
    });
    let data = await response.text();
    let access_token = data.substring(data.indexOf("access_token=") + 13);
    access_token = access_token.substring(0, access_token.indexOf('&'));
    log.info(`Git Hub Access token : ${access_token}`);
    return access_token;
}


async function create_user_repo(repoName, access_token) {
    // let createRepoUrl = `https://api.github.com/repos/adobe/helix-project-boilerplate/generate`;
    let createRepoUrl = `https://api.github.com/repos/hellofranklin/helix-project-boilerplate/generate`;
    log.info(createRepoUrl);
    let authtring = `Bearer ${access_token}`;
    log.info(authtring);
    let response = await fetch(createRepoUrl, {
        method: 'POST',
        headers: {'Authorization': authtring, 'Content-Type': 'application/json'},
        body: JSON.stringify({'name': repoName})
    });
    let data = await response.json();

    // log.info("response while creating user Repo " + JSON.stringify(data));
    log.info(`The Git Repo Created at : ${data['url']}`);
    return data;
}

//const googleClientId = encodeURIComponent("501719199475-4niikatk6ji212221m8ccj605nj3qgig.apps.googleusercontent.com");
const googleClientId = encodeURIComponent("709069296039-4j9ps75je88kfgvqgpp3sa3pb3c5fic2.apps.googleusercontent.com"); // Update Google Client Id

function createGoogleAuthUrl() {
    let google_scope = encodeURIComponent("https://www.googleapis.com/auth/drive");
    let url = '';
    url = `https://accounts.google.com/o/oauth2/v2/auth?scope=${google_scope}&include_granted_scopes=true&response_type=token&state=state_parameter_passthrough_value&redirect_uri=${REDIRECT_URI}&client_id=${googleClientId}`;
    return url;
}

let googleAccessToken = ''

async function get_gauth() {

    log.info("google access token : " + googleAccessToken);
    googleAccessToken = ''
    log.info(`going to ${createGoogleAuthUrl()}`);
    ``
    let redirect_url = await chrome.identity.launchWebAuthFlow({
        url: createGoogleAuthUrl(),
        interactive: true,
    });
    if (chrome.runtime.lastError) {
        // sendResponse({message: 'fail'});
    } else {
        log.info("chrome.runtime.lastError not present")
        if (redirect_url.includes('access_denied')) {
            sendResponse({message: 'fail'});
        } else {
            log.info("redirecturl: " + redirect_url);
            googleAccessToken = redirect_url.substring(redirect_url.indexOf('access_token=') + 13);
            googleAccessToken = googleAccessToken.substring(0, googleAccessToken.indexOf('&'));
            log.info(`googleAccessToken is ${googleAccessToken}`)
        }
    }
}

// async function uploadFile(){
//   log.info("going to upload file");
//   let gdocurl=`https://docs.googleapis.com/v1/documents`;
//
//   let response=await fetch('https://www.googleapis.com/upload/drive/v3/files', {
//     method: "POST",
//     headers:{Authorization: googleAccessToken},
//     body: formData
//   });
//   log.info(response);
//   alert('The file has been uploaded successfully.');
// }
// let driveUrl = '';

async function createFolder(folderName) {
    log.info("Creating a Folder in Google Drive" + googleAccessToken);

    let bodyjson = `{"name": "${folderName}", "mimeType": "application/vnd.google-apps.folder"}`;
    log.info(bodyjson);
    let response = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: "POST",
        headers: {Authorization: "Bearer " + googleAccessToken, 'Content-Type': 'application/json'},
        body: JSON.stringify({name: folderName, mimeType: 'application/vnd.google-apps.folder'})
    });
    let data = await response.json();
    let errormsg;
    if(errormsg=handleErrors(data)){
        throw Error("\nFailed to create Google drive Folder : " +errormsg);
    }
    log.info('The Folder has been Created successfully.');
    let fileId = data['id'];
    let folderUrl = `https://drive.google.com/drive/folders/${fileId}`;
    log.info(`The Google Drive Folder Created at : ${folderUrl}`);
    return fileId;
}

async function createPermission(fileId) {
    log.info("Giving permission to Helix Bot " + googleAccessToken);
    let bodyjson = {role: 'writer', type: 'user', emailAddress: 'helix@adobe.com'};
    log.info(JSON.stringify(bodyjson));
    let response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
        method: "POST",
        headers: {Authorization: "Bearer " + googleAccessToken, 'Content-Type': 'application/json'},
        body: JSON.stringify(bodyjson)
    });
    let data = await response.json();
    log.info("Respone: " + JSON.stringify(data));
    let errormsg;
    if(errormsg=handleErrors(data)){
        throw Error("\nFailed to give permission to Google drive Folder : " +errormsg);
    }
    log.info('The Folder has been given the permission successfully.');

}
function handleErrors(data){
    let errormsg;
    if(data["error"]) {
        if (data["error"]["message"]) {
            if (data["error"]["message"].includes("User message")) {
                errormsg = data["error"]["message"].substring(data["error"]["message"].indexOf("User message")+14);
            } else {
                errormsg = data["error"]["message"];
            }
        } else {
            errormsg = data;
        }
    }
    log.error(errormsg);
    return errormsg;
}

async function createindexFile(fileId) {
    let url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
    log.info("Creating an Index File " + googleAccessToken);

    let response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: "Bearer " + googleAccessToken,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        },
        body: JSON.stringify({name: 'index', mimeType: 'application/vnd.google-apps.document', parents: [fileId]})
    });
    let metaResponse = await response;
    let location = metaResponse.headers.get("location");
    log.info("location is : " + location);
    let response2 = await fetch(location, {
        method: "PUT",
        headers: {Authorization: "Bearer " + googleAccessToken},
        body: await getDefaultDocument()
    });
    let dataResponse = await response2.json();
    log.info("Response for creation is : " + JSON.stringify(dataResponse));
    let createdfileId = dataResponse['id'];
    let fileurl = `https://docs.google.com/document/d/${createdfileId}/edit`;
    return fileurl;
}

async function createIndexSpreadsheetFile(folderId) {
    let url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
    log.info("Creating a Spreadsheet File " + googleAccessToken);

    let response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: "Bearer " + googleAccessToken,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        },
        body: JSON.stringify({
            name: 'index',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: [folderId]
        })
    });
    let metaResponse = await response;
    let location = metaResponse.headers.get("location");
    log.info("speadsheet location is : " + location);
    let response2 = await fetch(location, {
        method: "PUT",
        headers: {Authorization: "Bearer " + googleAccessToken},
        body: await getDeafaultSpreadsheet()
    });
    let dataResponse = await response2.json();
    log.info("Response for spreadsheet creation is : " + JSON.stringify(dataResponse));
    let createdfileId = dataResponse['id'];
    let fileurl = `https://docs.google.com/spreadsheets/d/${createdfileId}/edit`;
    return fileurl;
}

async function editFsTab(giturl, gitAccessToken, folderId) {
    log.info("sleeping for 10 seconds before editing the FsTab");
    await new Promise(r => setTimeout(r, 2000));
    log.info("git access token :" + gitAccessToken);
    let driveUrl = `https://drive.google.com/drive/folders/${folderId}`;
    let editfsTaburl = giturl + '/contents/fstab.yaml'
    log.info("Updating the FsTab.Yaml at " + editfsTaburl);
    // let access_token=await get_access_token();
    let authtring = `Bearer ${gitAccessToken}`;
    log.info(authtring);
    let response1 = await fetch(editfsTaburl, {
        method: 'GET',
        headers: {'Authorization': authtring, 'Content-Type': 'application/json'}
    });
    let data1 = await response1.json();
    if(errormsg=handleErrors(data1)){
        throw Error("\nFailed to update FsTab : " +errormsg);
    }
    let blobsha = data1['sha'];

    let contentString = `mountpoints:
  /: ${driveUrl}`;
    log.info(`going to update FsTab.yaml : ${contentString}`);
    let bodyjson = {message: 'updated FsTab.Yaml', content: btoa(contentString), sha: blobsha};
    let response = await fetch(editfsTaburl, {
        method: 'PUT',
        headers: {'Authorization': authtring, 'Content-Type': 'application/json'},
        body: JSON.stringify(bodyjson)
    });
    let data = await response.json();
    let errormsg;
    if(errormsg=handleErrors(data)){
        throw Error("\nFailed to update FsTab : " +errormsg);
    }
    log.info(`The FSTab.yaml updated : ${JSON.stringify(data)}`);
    // log.info(` ${JSON.stringify(data)}`);
    return data;
}

function publish(gitcloneUrl) {
    chrome.runtime.sendMessage({
            message: {
                data: 'publish',
                gitcloneUrl: gitcloneUrl
            }
        });
}

async function getDeafaultSpreadsheet() {
    log.info('fetching the default spreadsheet')
    const url = 'https://docs.google.com/spreadsheets/d/1eBGxvborY5lYbeAUPMiBDgS2dArhtQzZdLS6QoGXONo/export?format=xlsx';
    let data;
    try {
        data = await fetch(url);
    } catch (e) {
        log.error(' failed to fetch the deafult spreadsheet : ', e);
    }
    return await data.blob();
}

async function getDefaultDocument() {
    log.info('fetching the default Document')
    const url = 'https://docs.google.com/document/d/19dMChEYu9SvcCE7qpUUFbdqgJF6LB9UIjWFwpD47M4k/export?format=docx';
    let data;
    try {
        data = await fetch(url);
    } catch (e) {
        log.error(' failed to fetch the default Document : ', e);
    }
    return await data.blob();
}

async function addTemplate(templateId, folderId) {
    log.info("Adding Templates templateID:" + templateId);

    let spreadsheetEntries = propertiesObject["sites"][templateId]['excel'];
    if (spreadsheetEntries != undefined) {
        for (const fileName of Object.keys(spreadsheetEntries)) {
            log.info("creating the default spreadsheet file : " + fileName + "|" + spreadsheetEntries[fileName]);
            await createDefaultFiles(folderId, fileName, await getSpreadsheet(spreadsheetEntries[fileName]), 'excel');
        }
    }
    let documentEntries = propertiesObject["sites"][templateId]['word'];
    if (documentEntries != undefined) {
        for (const fileName of Object.keys(documentEntries)) {
            log.info("creating the default word file : " + fileName + "|" + documentEntries[fileName]);
            await createDefaultFiles(folderId, fileName, await getDocument(documentEntries[fileName]), 'word');
        }
    }


}

let propertiesObject = {
    sites: {
        blanksite: {
            word: {
                index: "1oG9poB0D9SPEx92D0kxe2Q-uO9quqiNbErrEWSZsh44"
            }
        },
        defaultsite: {
            word: {
                index: "1ao14f64ZAHthC0xpOr4ZOfo-dUV6TE_Qa-niI-j3I8Y",
                nav: "1XiPVdcZpNAb8ITb3uID_wOV6hhsYg0Fn8VHNK81Ym7M",
                footer: "13zXdOAzdHUpsxeyDQ7-PKnRDS0mv7PCc_DNWwVXW0-E"
            }
        }
    },
    forms: {
        calculator: {
            excel: {
                form: "1MBtNndkERWsS9Nhgu2NflcSWMuH9xFiM",
                calculator: "1nK4osdexA1iqakH7lMDRvxdPO-IBgEI_",
                personalLoan2: "1awbuiTxtIikPj7-mKFxDNPisAcp-elRh"
            },
            word: {
                form: "1P2VcrTJwFgJvglTwcCrcaT0ZNrHVspF-",
                index: "1BlbqQmRAVe3iXHqYSHLJY191Mgx-OFcn"
            }
        }
    }
}

async function getSpreadsheet(sheetId) {
    log.info('fetching the spreadsheet ' + sheetId)
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
    let data;
    try {
        data = await fetch(url);
    } catch (e) {
        log.error(' failed to fetch the deafult spreadsheet : ', e);
    }
    return await data.blob();
}

async function getDocument(documentId) {
    log.info('fetching the Document ' + documentId)
    const url = `https://docs.google.com/document/d/${documentId}/export?format=docx`;
    let data;
    try {
        data = await fetch(url);
    } catch (e) {
        log.error(' failed to fetch the default Document : ', e);
    }
    return await data.blob();
}

async function createDefaultFiles(folderId, fileName, fileblob, type) {
    let url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
    let uploadContentType;
    let mimeType;
    if (type == 'excel') {
        // log.info("Creating a Spreadsheet File ");
        uploadContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        mimeType = 'application/vnd.google-apps.spreadsheet';
    } else if (type == 'word') {
        // log.info("Creating a word File ");
        uploadContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        mimeType = 'application/vnd.google-apps.document';
    }
    let response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: "Bearer " + googleAccessToken,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': uploadContentType
        },
        body: JSON.stringify({name: fileName, mimeType: mimeType, parents: [folderId]})
    });
    let metaResponse = await response;
    let errormsg;
    if(errormsg=handleErrors(metaResponse)){
        throw Error("\nFailed to create Tempate : " +errormsg);
    }
    let location = metaResponse.headers.get("location");
    // log.info("file location is : " + location);
    let response2 = await fetch(location, {
        method: "PUT",
        headers: {Authorization: "Bearer " + googleAccessToken},
        body: await fileblob
    });
    let dataResponse = await response2.json();
    if(errormsg=handleErrors(data)){
        throw Error("\nFailed to create Tempate : " +errormsg);
    }
    log.info("Response for file creation is : " + JSON.stringify(dataResponse));
    let createdfileId = dataResponse['id'];
    // let fileurl=`https://docs.google.com/spreadsheets/d/${createdfileId}/edit`;
    // return fileurl;
}


async function installHelixbot() {
    let response = chrome.identity.launchWebAuthFlow({url: "https://github.com/apps/helix-bot", interactive: true});
    // let data = log.info(JSON.stringify(await response));
}


// https://github.com/login/oauth/access_token
//https://docs.google.com/document/d/1Zq5wV4iey32b7nQFsRNBudMP6RKP_IM5RVjj0ShCQCg/edit?usp=share_link
