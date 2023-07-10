import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs/promises';
import { normalize } from 'path';
import * as toml from 'toml'

async function createRelease(tagName: string, targetCommitish: string, name: string, body: string, githubToken: string): Promise<string>
{
    const octokit = github.getOctokit(githubToken);

    const createReleaseResponse = await octokit.rest.repos.createRelease({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        tag_name: tagName,
        target_commitish: targetCommitish,
        name: name,
        body: body,
        draft: true,
        prerelease: false,
    });

    return createReleaseResponse.data.upload_url;
}

async function uploadAsset(uploadUrl: string, assetPath: string, assetName: string, githubToken: string): Promise<void>
{
    assetPath = normalize(assetPath);
    const octokit = github.getOctokit(githubToken);

    const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String((await fs.stat(assetPath)).size),
    };

    const uploadAssetResponse = await octokit.request({
        method: 'POST',
        url: uploadUrl,
        headers,
        data: fs.readFile(assetPath),
    });

    if (uploadAssetResponse.status !== 201)
    {
        throw new Error(`Failed to upload asset: ${uploadAssetResponse.status} - ${uploadAssetResponse.data}`);
    }

    core.info(`Uploaded asset ${assetName}`);
}


function getTarget(): string
{
    const target: string = core.getInput('target');

    if (target !== '')
        return target;

    if (process.platform === 'linux')
    {
        return 'x86_64-unknown-linux-gnu';
    }
    else if (process.platform === 'win32')
    {
        return 'x86_64-pc-windows-msvc';
    }
    else if (process.platform === 'darwin')
    {
        return 'aarch64-apple-darwin';
    }
    else
    {
        core.setFailed(`Unsupported operating system: ${process.platform}`);
        process.exit();
    }
}

async function getProjectToml()
{
    let cargoTomlPath: string = core.getInput('cargo-toml-path');

    if (cargoTomlPath === "")
    {
        cargoTomlPath = "./Cargo.toml";
    }
    cargoTomlPath = normalize(cargoTomlPath)

    try
    {
        const cargoTomlContents: string = await fs.readFile(
            cargoTomlPath,
            { encoding: 'utf8' });
        return toml.parse(cargoTomlContents);;
    }
    catch (error: unknown)
    {
        if (error instanceof Error)
            core.setFailed(error.message);
        process.exit();
    }
}

async function run()
{
    try
    {
        const target = getTarget();
        if (process.platform === 'darwin')
        {
            await exec.exec('rustup', ['target', 'add', 'aarch64-apple-darwin']);
        }
        await exec.exec('cargo', ['build', '--release', '--target', target]);

        const cargoToml: any = await getProjectToml();

        const publishRelease: boolean = core.getInput('publish-release') === 'true';
        if (!publishRelease)
        {
            core.setOutput('output', 'Successfully compiled Rust code.');
            process.exit();
        }

        const githubToken: string | undefined = process.env.GITHUB_TOKEN;
        if (githubToken === undefined)
        {
            core.setFailed("Failed to retrieve github token, please make sure to add GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} to your env tag");
            process.exit();
        }

        core.info('Creating release...');
        const tagName: string | undefined = github.context.ref.split("/").pop();
        if (tagName === undefined)
        {
            throw new Error("Tag name is undefined.");
        }

        core.info(`Tag name: ${tagName}`);
        core.info(`Package version: ${cargoToml.package.version}`);

        const uploadUrl = await createRelease(
            tagName,
            github.context.sha,
            `v${cargoToml.package.version}`,
            'Description of the release.',
            githubToken
        );
        core.info('Release created.');

        core.info('Uploading asset...');
        core.info(`Package name: ${cargoToml.package.name}`);
        core.info(`Package version: ${cargoToml.package.version}`);

        await uploadAsset(
            uploadUrl,
            process.platform === 'win32' ?
                `target/${target}/release/${cargoToml.package.name}.exe` :
                `target/${target}/release/${cargoToml.package.name}`,
            cargoToml.package.name,
            githubToken
        );
        core.info('Asset uploaded.');

        core.setOutput('output', 'Successfully compiled and drafted your Rust code.');

    }
    catch (error: unknown)
    {
        if (error instanceof Error)
            core.setFailed(error.message);
    }
}


run();
