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

import { log } from './utils.js';

const CLIENT_ID = encodeURIComponent('7f57ca41ae308a1e499c'); // UPDATE GIT CLIENT ID
const GIT_CLIENT_SECRET = '576d72f19970fc1c2f495f27181663342d6b5781';
const REDIRECT_URI = chrome.identity.getRedirectURL();
const googleClientId = encodeURIComponent('709069296039-4j9ps75je88kfgvqgpp3sa3pb3c5fic2.apps.googleusercontent.com'); // Update Google Client Id

async function getGoogleAccessToken() {
  const googleScope = encodeURIComponent('https://www.googleapis.com/auth/drive');
  const googleAuthURL = `https://accounts.google.com/o/oauth2/v2/auth?scope=${googleScope}&include_granted_scopes=true&response_type=token&state=state_parameter_passthrough_value&redirect_uri=${REDIRECT_URI}&client_id=${googleClientId}`;
  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: googleAuthURL,
    interactive: true,
  });
  if (chrome.runtime.lastError) {
    // sendResponse({message: 'fail'});
  } else if (redirectUrl.includes('access_denied')) {
    // sendResponse({ message: 'fail' });
  } else {
    let googleAccessToken = redirectUrl.substring(redirectUrl.indexOf('access_token=') + 13);
    googleAccessToken = googleAccessToken.substring(0, googleAccessToken.indexOf('&'));
    return googleAccessToken;
  }
  return null;
}

function sendStatusMessage(statusMessage, percentCompletion) {
  chrome.runtime.sendMessage({
    message: {
      data: 'statusUpdate',
    },
    statusMessage,
    percentCompletion,
  });
}

function handleErrors(data) {
  let errormsg;
  if (data.error) {
    if (data.error.message) {
      if (data.error.message.includes('User message')) {
        errormsg = data.error.message.substring(data.error.message.indexOf('User message') + 14);
      } else {
        errormsg = data.error.message;
      }
    } else {
      errormsg = data;
    }
  }
  log.error(errormsg);
  return errormsg;
}

async function getGitHubAuthToken() {
  let gitAuthToken = '';
  const gitAuthEndPoint = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=repo,gist,admin`;
  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: gitAuthEndPoint,
    interactive: true,
  });
  if (redirectUrl.includes('error=access_denied')) {
    const errormsg = ' Access denied !';
    throw Error(`Failed to Authorize Git : ${errormsg}`);
  } else {
    gitAuthToken = redirectUrl.substring(redirectUrl.indexOf('code=') + 5);
    setTimeout(() => {
      gitAuthToken = '';
    }, 3600000);
  }
  return gitAuthToken;
}

async function getAccessToken(gitAuthToken) {
  const getaccesstokenurl = 'https://github.com/login/oauth/access_token';
  const bodyjson = JSON.stringify({
    client_id: CLIENT_ID,
    client_secret: GIT_CLIENT_SECRET,
    code: gitAuthToken,
  });
  const response = await fetch(getaccesstokenurl, {
    method: 'POST',
    headers: { Authentication: gitAuthToken, 'Content-Type': 'application/json' },
    body: bodyjson,
  });
  const data = await response.text();
  const accessToken = data.substring(data.indexOf('access_token=') + 13);
  return accessToken.substring(0, accessToken.indexOf('&'));
}

async function createUserRepo(repoName, accessToken) {
  const createRepoUrl = 'https://api.github.com/repos/hellofranklin/helix-project-boilerplate/generate';
  const authtring = `Bearer ${accessToken}`;
  const response = await fetch(createRepoUrl, {
    method: 'POST',
    headers: { Authorization: authtring, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: repoName }),
  });
  return response.json();
}

async function createFolder(folderName, googleAccessToken) {
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const data = await response.json();
  let errormsg;
  if (handleErrors(data) !== undefined) {
    throw Error(`\nFailed to create Google drive Folder : ${errormsg}`);
  }
  log.info('The Folder has been Created successfully.');
  return data.id;
}

async function createPermission(fileId, googleAccessToken) {
  const bodyjson = { role: 'writer', type: 'user', emailAddress: 'helix@adobe.com' };

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyjson),
  });
  const data = await response.json();

  const errormsg = handleErrors(data);
  if (errormsg !== undefined) {
    throw Error(`\nFailed to give permission to Google drive Folder : ${errormsg}`);
  }
  log.info('The Folder has been given the permission successfully.');
}

async function editFsTab(giturl, gitAccessToken, folderId) {
  setTimeout(() => {}, 2000);
  const driveUrl = `https://drive.google.com/drive/folders/${folderId}`;
  const editfsTaburl = `${giturl}/contents/fstab.yaml`;
  const authtring = `Bearer ${gitAccessToken}`;
  const response1 = await fetch(editfsTaburl, {
    method: 'GET',
    headers: { Authorization: authtring, 'Content-Type': 'application/json' },
  });

  const data1 = await response1.json();
  let errormsg = handleErrors(data1);
  if (errormsg !== undefined) {
    throw Error(`\nFailed to update FsTab : ${errormsg}`);
  }
  const blobsha = data1.sha;
  const contentString = `mountpoints:
  /: ${driveUrl}`;
  log.info(`going to update FsTab.yaml : ${contentString}`);
  const bodyjson = { message: 'updated FsTab.Yaml', content: btoa(contentString), sha: blobsha };
  const response = await fetch(editfsTaburl, {
    method: 'PUT',
    headers: { Authorization: authtring, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyjson),
  });
  const data = await response.json();
  errormsg = handleErrors(data);
  if (errormsg !== undefined) {
    throw Error(`\nFailed to update FsTab : ${errormsg}`);
  }
  if (data.commit.message.includes('updated')) {
    log.info(`The FSTab.yaml updated : ${JSON.stringify(data)}`);
  }
  return data;
}

function publish(gitcloneUrl) {
  chrome.runtime.sendMessage({
    message: {
      data: 'publish',
      gitcloneUrl,
    },
  });
}

const propertiesObject = {
  sites: {
    blanksite: {
      word: {
        index: '1oG9poB0D9SPEx92D0kxe2Q-uO9quqiNbErrEWSZsh44',
      },
    },
    defaultsite: {
      word: {
        index: '1ao14f64ZAHthC0xpOr4ZOfo-dUV6TE_Qa-niI-j3I8Y',
        nav: '1XiPVdcZpNAb8ITb3uID_wOV6hhsYg0Fn8VHNK81Ym7M',
        footer: '13zXdOAzdHUpsxeyDQ7-PKnRDS0mv7PCc_DNWwVXW0-E',
      },
    },
  },
  forms: {
    calculator: {
      excel: {
        form: '1MBtNndkERWsS9Nhgu2NflcSWMuH9xFiM',
        calculator: '1nK4osdexA1iqakH7lMDRvxdPO-IBgEI_',
        personalLoan2: '1awbuiTxtIikPj7-mKFxDNPisAcp-elRh',
      },
      word: {
        form: '1P2VcrTJwFgJvglTwcCrcaT0ZNrHVspF-',
        index: '1BlbqQmRAVe3iXHqYSHLJY191Mgx-OFcn',
      },
    },
  },
};

async function getSpreadsheet(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
  let data;
  try {
    data = await fetch(url);
  } catch (e) {
    log.error(' failed to fetch the deafult spreadsheet : ', e);
  }
  return data.blob();
}

async function getDocument(documentId) {
  const url = `https://docs.google.com/document/d/${documentId}/export?format=docx`;
  let data;
  try {
    data = await fetch(url);
  } catch (e) {
    log.error(' failed to fetch the default Document : ', e);
  }
  return data.blob();
}

async function createDefaultFiles(folderId, fileName, fileblob, type, googleAccessToken) {
  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
  let uploadContentType;
  let mimeType;
  if (type === 'excel') {
    uploadContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    mimeType = 'application/vnd.google-apps.spreadsheet';
  } else if (type === 'word') {
    uploadContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    mimeType = 'application/vnd.google-apps.document';
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${googleAccessToken}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': uploadContentType,
    },
    body: JSON.stringify({ name: fileName, mimeType, parents: [folderId] }),
  });
  const metaResponse = await response;
  let errormsg = handleErrors(metaResponse);
  if (errormsg !== undefined) {
    throw Error(`\nFailed to create Tempate : ${errormsg}`);
  }
  const location = metaResponse.headers.get('location');
  // log.info("file location is : " + location);
  const response2 = await fetch(location, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${googleAccessToken}` },
    body: await fileblob,
  });
  const dataResponse = await response2.json();
  errormsg = handleErrors(dataResponse);
  if (errormsg !== undefined) {
    throw Error(`\nFailed to create Tempate : ${errormsg}`);
  }
}

async function addTemplate(templateId, folderId, googleAccessToken) {
  const spreadsheetEntries = propertiesObject.sites[templateId].excel;
  if (spreadsheetEntries !== undefined) {
    for (const fileName of Object.keys(spreadsheetEntries)) {
      createDefaultFiles(folderId, fileName, getSpreadsheet(spreadsheetEntries[fileName]), 'excel', googleAccessToken);
    }
  }
  const documentEntries = propertiesObject.sites[templateId].word;
  if (documentEntries !== undefined) {
    for (const fileName of Object.keys(documentEntries)) {
      createDefaultFiles(folderId, fileName, getDocument(documentEntries[fileName]), 'word', googleAccessToken);
    }
  }
}

async function installHelixbot() {
  chrome.identity.launchWebAuthFlow({ url: 'https://github.com/apps/helix-bot', interactive: true });
}

export async function oneclicksample(siteName, templateId) {
  try {
    sendStatusMessage('Setting Up Git Repo ...', 0);
    sendStatusMessage('Setting Up Git Repo ...', 1);
    const gitAuthToken = await getGitHubAuthToken();
    const gitAccessToken = await getAccessToken(gitAuthToken);
    sendStatusMessage('Setting Up Git Repo ...', 15);
    const gitData = await createUserRepo(siteName, gitAccessToken);
    sendStatusMessage('Git repo successfully created', 33);
    const giturl = gitData.url;
    const gitcloneUrl = gitData.clone_url;
    sendStatusMessage('Setting up Google Drive folder...', 40);
    const googleAccessToken = await getGoogleAccessToken();
    const targetFolderId = await createFolder(siteName, googleAccessToken);
    sendStatusMessage('Google Drive folder created successfully', 50);
    sendStatusMessage('Giving Permission to Google Drive', 53);
    await createPermission(targetFolderId, googleAccessToken);
    sendStatusMessage('Giving Permission to Google Drive', 60);
    sendStatusMessage('Updating FsTab', 65);
    await editFsTab(giturl, gitAccessToken, targetFolderId);
    sendStatusMessage('Adding Templates', 75);
    await addTemplate(templateId, targetFolderId, googleAccessToken);
    sendStatusMessage('Templates Added Templates', 85);
    sendStatusMessage('Setup Helix Bot', 90);
    await installHelixbot();
    sendStatusMessage('Helix Bot added successfully', 95);
    sendStatusMessage('Project setup completed !', 100);
    publish(gitcloneUrl);
  } catch (e) {
    sendStatusMessage(`Failed to create Franklin Project \n${e.message}`, 0);
  }
}

// async function createindexFile(fileId) {
//   const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
//   log.info(`Creating an Index File ${googleAccessToken}`);

//   const response = await fetch(url, {
//     method: 'POST',
//     headers: {
//       Authorization: `Bearer ${googleAccessToken}`,
//       'Content-Type': 'application/json',
//       'X-Upload-Content-Type':
// 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
//     },
//     body: JSON.stringify(
// { name: 'index', mimeType: 'application/vnd.google-apps.document', parents: [fileId] }),
//   });
//   const metaResponse = await response;
//   const location = metaResponse.headers.get('location');
//   log.info(`location is : ${location}`);
//   const response2 = await fetch(location, {
//     method: 'PUT',
//     headers: { Authorization: `Bearer ${googleAccessToken}` },
//     body: await getDefaultDocument(),
//   });
//   const dataResponse = await response2.json();
//   log.info(`Response for creation is : ${JSON.stringify(dataResponse)}`);
//   const createdfileId = dataResponse.id;
//   const fileurl = `https://docs.google.com/document/d/${createdfileId}/edit`;
//   return fileurl;
// }

// async function createIndexSpreadsheetFile(folderId) {
//   const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
//   log.info(`Creating a Spreadsheet File ${googleAccessToken}`);

//   const response = await fetch(url, {
//     method: 'POST',
//     headers: {
//       Authorization: `Bearer ${googleAccessToken}`,
//       'Content-Type': 'application/json',
//       'X-Upload-Content-Type':
//    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
//     },
//     body: JSON.stringify({
//       name: 'index',
//       mimeType: 'application/vnd.google-apps.spreadsheet',
//       parents: [folderId],
//     }),
//   });
//   const metaResponse = await response;
//   const location = metaResponse.headers.get('location');
//   log.info(`speadsheet location is : ${location}`);
//   const response2 = await fetch(location, {
//     method: 'PUT',
//     headers: { Authorization: `Bearer ${googleAccessToken}` },
//     body: await getDeafaultSpreadsheet(),
//   });
//   const dataResponse = await response2.json();
//   log.info(`Response for spreadsheet creation is : ${JSON.stringify(dataResponse)}`);
//   const createdfileId = dataResponse.id;
//   const fileurl = `https://docs.google.com/spreadsheets/d/${createdfileId}/edit`;
//   return fileurl;
// }
