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

const REDIRECT_URI = chrome.identity.getRedirectURL();
const TEMPLATE_FOLDER_ID = '1x1IOTj3iTNqAonbzfvvKUv6lAzVHKZ_Z';
const DOCUMENT_TYPE_MAP = {
  'application/vnd.google-apps.spreadsheet': 'xlsx',
  'application/vnd.google-apps.document': 'docx',
  'application/vnd.google-apps.folder': 'folder',
};

async function getGoogleAccessToken() {
  const { oauth2 } = chrome.runtime.getManifest();
  const googleAuthURL = `https://accounts.google.com/o/oauth2/v2/auth?scope=${oauth2.scopes}&include_granted_scopes=true&response_type=token&state=state_parameter_passthrough_value&redirect_uri=${REDIRECT_URI}&client_id=${oauth2.client_id}`;
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

function sendStatusMessage(statusMessage, percentCompletion, error) {
  chrome.runtime.sendMessage({
    message: {
      data: 'statusUpdate',
    },
    statusMessage,
    percentCompletion,
    error: error?.message,
  });
}

function handleErrors(data) {
  let errorMessage = data.error ? data.error.message : data;
  if (errorMessage.includes('User message')) {
    errorMessage = errorMessage.substring(errorMessage.indexOf('User message') + 14);
  }
  log.error(`Handling Error : ${JSON.stringify(errorMessage)}`);
  return errorMessage;
}

async function getGitHubAuthToken() {
  const { oauth2 } = chrome.runtime.getManifest();
  let gitAuthToken = '';
  const gitAuthEndPoint = `https://github.com/login/oauth/authorize?client_id=${oauth2.git_client_id}&redirect_uri=${REDIRECT_URI}&scope=repo,gist,admin`;
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

async function getGithubAccessToken() {
  const { oauth2 } = chrome.runtime.getManifest();
  const gitAuthToken = await getGitHubAuthToken();
  const url = 'https://github.com/login/oauth/access_token';
  const body = JSON.stringify({
    client_id: oauth2.git_client_id,
    client_secret: oauth2.git_client_secret,
    code: gitAuthToken,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: gitAuthToken, 'Content-Type': 'application/json' },
    body,
  });
  const data = await response.text();
  const startIndex = data.indexOf('access_token=') + 13;
  const endIndex = data.indexOf('&');
  return data.substring(startIndex, endIndex);
}

async function createUserRepo(repoName, accessToken) {
  const createRepoUrl = 'https://api.github.com/repos/hellofranklin/helixboilerplate/generate';
  const authtring = `Bearer ${accessToken}`;
  const response = await fetch(createRepoUrl, {
    method: 'POST',
    headers: { Authorization: authtring, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: repoName }),
  });
  return response.json();
}

async function createGDriveFolder(folderName, googleAccessToken) {
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const data = await response.json();
  if (response.status !== 200) {
    let errormsg;
    if (handleErrors(data) !== undefined) {
      throw Error(`\nFailed to create Google drive Folder : ${errormsg}`);
    }
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
  if (response.status !== 200) {
    const errormsg = handleErrors(data);
    if (errormsg !== undefined) {
      throw Error(`\nFailed to give permission to Google drive Folder : ${errormsg}`);
    }
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
  if (response1.status !== 200) {
    const errormsg = handleErrors(data1);
    if (errormsg !== undefined) {
      throw Error(`\nFailed to update FsTab : ${errormsg}`);
    }
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
  if (response.status !== 200) {
    const errormsg = handleErrors(data);
    if (errormsg !== undefined) {
      throw Error(`\nFailed to update FsTab : ${errormsg}`);
    }
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

async function getFile(documentId, docType) {
  const url = `https://docs.google.com/document/d/${documentId}/export?format=${docType}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Request failed with status code ${response.status}`);
    }
    return response.blob();
  } catch (e) {
    throw new Error(`Failed to fetch the default Document: ${e.message}`);
  }
}

async function uploadFile(folderId, fileName, fileblob, docType, googleAccessToken) {
  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
  let uploadContentType;
  let mimeType;
  if (docType === 'xlsx') {
    uploadContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    mimeType = 'application/vnd.google-apps.spreadsheet';
  } else if (docType === 'docx') {
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
  if (metaResponse.status !== 200) {
    const errormsg = handleErrors(metaResponse);
    if (errormsg !== undefined) {
      throw Error(`\nFailed to create Tempate : ${errormsg}`);
    }
  }
  const location = metaResponse.headers.get('location');
  const response2 = await fetch(location, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${googleAccessToken}` },
    body: await fileblob,
  });
  const dataResponse = await response2.json();
  if (dataResponse.status !== 200) {
    const errormsg = handleErrors(dataResponse);
    if (errormsg !== undefined) {
      throw Error(`\nFailed to create Tempate : ${errormsg}`);
    }
  }
}

async function getTemplateFolderId(templatesFolderID, templateName, googleAccessToken) {
  const params = new URLSearchParams({
    q: `'${templatesFolderID}' in parents and name='${templateName}'`,
  });
  const driveURL = `https://www.googleapis.com/drive/v3/files?${params}`;
  try {
    const response = await fetch(driveURL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Request failed with status code ${response.status}`);
    }
    const responseJson = await response.json();
    if (responseJson.error) {
      throw new Error(responseJson.error.message);
    }
    for (const item of responseJson.files) {
      if (item.name === templateName) return item.id;
    }
    return null;
  } catch (e) {
    throw new Error(`Failed to fetch template folder ID: ${e.message}`);
  }
}

async function getFolderItemsByID(templateFolderID, googleAccessToken) {
  const params = new URLSearchParams({
    q: `'${templateFolderID}' in parents`,
  });
  const driveURL = `https://www.googleapis.com/drive/v3/files?${params}`;
  try {
    const response = await fetch(driveURL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Request failed with status code ${response.status}`);
    }
    const responseJson = await response.json();
    if (responseJson.error) {
      throw new Error(responseJson.error.message);
    }
    return responseJson.files;
  } catch (e) {
    throw new Error(`Failed to fetch folder items: ${e.message}`);
  }
}

function getDocumentType(fileMimeType) {
  return DOCUMENT_TYPE_MAP[fileMimeType] || 'file';
}

async function addTemplate(tempName, targetFolderId, gAccessToken) {
  const templateFolderId = await getTemplateFolderId(TEMPLATE_FOLDER_ID, tempName, gAccessToken);
  const templateFiles = await getFolderItemsByID(templateFolderId, gAccessToken);

  for (const tempFile of templateFiles) {
    const documentType = getDocumentType(tempFile.mimeType);
    if (documentType === 'xlsx' || documentType === 'docx') {
      const dataBlob = getFile(tempFile.id, documentType);
      dataBlob.then((result) => {
        uploadFile(targetFolderId, tempFile.name, result, documentType, gAccessToken);
      });
    }
  }
}

async function installHelixbot() {
  chrome.identity.launchWebAuthFlow({ url: 'https://github.com/apps/helix-bot', interactive: true });
}

export async function oneclicksample(siteName, templateName) {
  try {
    sendStatusMessage('Setting Up Git Repo ...', 0);
    const gitAccessToken = await getGithubAccessToken();
    sendStatusMessage('Setting Up Git Repo ...', 15);
    const gitData = await createUserRepo(siteName, gitAccessToken);
    sendStatusMessage('Git repo successfully created', 33);
    const giturl = gitData.url;
    const gitcloneUrl = gitData.clone_url;
    sendStatusMessage('Setting up Google Drive folder...', 40);
    const googleAccessToken = await getGoogleAccessToken();
    const targetFolderId = await createGDriveFolder(siteName, googleAccessToken);
    sendStatusMessage('Google Drive folder created successfully', 50);
    sendStatusMessage('Giving Permission to Google Drive', 53);
    await createPermission(targetFolderId, googleAccessToken);
    sendStatusMessage('Giving Permission to Google Drive', 60);
    sendStatusMessage('Updating FsTab', 65);
    await editFsTab(giturl, gitAccessToken, targetFolderId);
    sendStatusMessage('Adding Templates', 75);
    await addTemplate(templateName, targetFolderId, googleAccessToken);
    sendStatusMessage('Templates Added Templates', 85);
    sendStatusMessage('Setup Helix Bot', 90);
    await installHelixbot();
    sendStatusMessage('Helix Bot added successfully', 95);
    sendStatusMessage('Project setup completed !', 100);
    publish(gitcloneUrl);
  } catch (e) {
    log.error(`Failed to create Franklin Project ${JSON.stringify(e)}`);
    sendStatusMessage('Failed to create Franklin Project ', 0, e);
  }
}
