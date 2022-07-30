const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const git = require('git-clone-or-pull');
const rate = require('express-rate-limit')

// Sitemap and robots.txt
const robots = require('express-robots-txt');
const {SitemapStream} = require('sitemap');
const {createGzip} = require('zlib')

// Spiget fetching
const {Spiget, Pagination} = require('spiget');
const spiget = new Spiget("William278UpdateApi");

// GitHub flavoured Markdown parsing
const MarkdownIt = require('markdown-it');
const markdown = new MarkdownIt({
    html: true, xhtmlOut: true, breaks: true
}).use(require('markdown-it-wikilinks')({
    postProcessPageName: (pageName) => {
        pageName = pageName.trim()
        pageName = pageName.split('/').map(require('sanitize-filename')).join('/')
        pageName = pageName.replace(/\s+/, '-')
        return pageName
    }, uriSuffix: ''
})).use(require('markdown-it-anchor'))
    .use(require('markdown-it-prism'), {
        defaultLanguage: 'yml'
    });

// App setup
const app = express();
const host = process.env.HOST || 'localhost';
const port = process.env.PORT || 8000;
const domain = process.env.DOMAIN || 'https://william278.net';
const content = path.join(__dirname, 'content');
const projects = JSON.parse(fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8'));
const limiter = rate({
    windowMs: 10 * 60 * 100, // 1 minute
    max: 500, // Limit each IP to 1000 requests per `window` (here, per 15 minutes)
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
const ORGANIZATION = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    "url": domain,
    "logo": domain + "/images/icons/huskhelp.png",
});

// Robots.txt setup
app.use(robots({
    UserAgent: '*',
    Disallow: '/api/',
    CrawlDelay: '5',
    Sitemap: domain + '/sitemap.xml',
}));

// Get current git head version
const version = require('child_process')
    .execSync('git rev-parse HEAD')
    .toString().trim().substring(0, 7);

// Search caching
let searchCache = {};

// Home page
app.get('/', (req, res) => {
    res.render('home', {
        'version': version,
        'projects': projects,
        'title': 'Open source Minecraft server software & game projects - William278.net',
        'description': 'Easily-accessible documentation and information site for all of William278\'s Minecraft plugins, projects & games.',
        'breadcrumbs': generateBreadcrumbs(req.url),
        'organization': ORGANIZATION
    });
});


// Handle transcripts
app.get('/transcript', (req, res) => {
    if (!req.url.endsWith('.html')) {
        if (!fs.existsSync(req.url)) {
            sendError(res, '404');
            return;
        }
        return;
    }
    let key = Object.keys(req.query)[0];
    if (key && key.length > 0) {
        try {
            let url = new URL(key);
            if (url.hostname !== 'cdn.discordapp.com') {
                sendError(res, '400', 'Invalid hostname.');
                return;
            }
        } catch (error) {
            sendError(res, '400', 'Invalid URL.');
            return;
        }
        fetch(key).then(response => {
            if (response.status !== 200) {
                throw response.status;
            }
            if (!response.headers.get("Content-Disposition").endsWith(".html, attachment")) {
                console.log("Attempted to parse an invalid html file " + response.headers.get("Content-Disposition"));
                throw 400;
            }
            return response.text();
        }).then(html => {
            return html.replace("<html>", "")
                .replace("</html>", "")
                .replace("<!DOCTYPE html>", "");
        }).then(html => {
            res.render('transcript', {
                'version': version,
                'transcript': html,
                'title': `View HuskHelp Support Ticket Transcript (${key.split('/').pop()}) - William278.net`,
                'description': `Read a transcript of this HuskHelp Discord support ticket (${key.split('/').pop()}), including messages and attatchments`,
                'breadcrumbs': generateBreadcrumbs(req.url),
                'organization': ORGANIZATION
            });
        }).catch(code => {
            sendError(res, code, 'That transcript is invalid or has expired.');
        });
        return;
    }
    sendError(res, '400', 'Bad request.');
});

// Serve the documentation index
app.get('/docs', (req, res) => {
    return res.render('docs-index', {
        'version': version,
        'title': 'Documentation for HuskHomes, HuskSync & more - William278.net',
        'description': 'Documentation for William278\'s various projects, including HuskHomes, HuskSync, HuskTowns & HuskChat.',
        'breadcrumbs': generateBreadcrumbs(req.url),
        'organization': ORGANIZATION
    });
});

// Serve documentation pages
app.get(['/docs/:name/(:page)?', '/docs/:name'], (req, res) => {
    // If the request ends with a forward slash, redirect to the same page without the forward slash
    if (req.url.endsWith('/')) {
        res.redirect(req.url.slice(0, -1));
        return;
    }

    // Serve page with markdown
    let name = req.params.name.toLowerCase();
    if (!req.params.page) {
        res.redirect(`/docs/${name}/Home`);
        return;
    }
    let page = req.params.page;

    // Find project with documentation by name
    let project = projects.find(project => project.name.toLowerCase() === name);
    if (!project) {
        sendError(res, '404', 'Invalid product.');
        return;
    }
    if (!project.documentation) {
        sendError(res, '404', 'There are no documentation pages for this product.');
        return;
    }

    // Send the page
    let pagePath = path.join(content, `docs/${name.toLowerCase()}/${page}.md`);
    if (fs.existsSync(pagePath)) {
        let sidebarPath = path.join(content, `docs/${name.toLowerCase()}/_Sidebar.md`);
        if (fs.existsSync(sidebarPath)) {
            let pageTitle = page.replace(/-/g, ' ');
            res.render('docs', {
                'version': version,
                'projectName': project.name,
                'pageName': pageTitle,
                'navigation': markdown.render(fs.readFileSync(sidebarPath, 'utf8')),
                'markdown': markdown.render(fs.readFileSync(pagePath, 'utf8')),
                'title': `Documentation for ${project.name} - ${pageTitle} - William278.net`,
                'description': `Read the documentation for ${project.name} by William278 - ${pageTitle} ${project.tags ? `(${project.tags.join(', ')})` : ''}`,
                'breadcrumbs': generateBreadcrumbs(req.url),
                'organization': ORGANIZATION
            });
        }
    } else {
        sendError(res, '404', 'Documentation page not found.');
    }
});


// Handle post requests to update project documentation
app.post('/api/update-docs', (req, res) => {
    const name = req.body.name;
    const repository = req.body.repository;
    if (name && repository) {
        // Validate that projects contains the project
        if (projects.find(project => project.repository === repository && project.name.toLowerCase() === name.toLowerCase())) {
            updateDocs(repository, name);
            res.status(200).send('OK');
        }

        // Clear the search cache
        searchCache = {};
    }
    res.status(400).send('Bad request');
});


// Search for matches of the query in the read page string
const searchPage = (query, markdown) => {
    let matches = [];
    let regex = new RegExp(query, 'gi');
    let match = regex.exec(markdown);
    while (match) {
        matches.push(match.index);
        match = regex.exec(markdown);
    }
    return matches;
}


// Serves a list of search results for a query term
app.get(['/api/search-docs/(:name)?', '/api/search-docs'], (req, res) => {
    const query = req.query.query;
    if (!query) {
        res.status(400).send('Bad request');
        return;
    }
    // Limit query size to 32
    if (query.length > 32) {
        res.status(400).send('Query too long');
        return;
    }

    let projectsToSearch = [];
    const queryName = req.params.name;
    if (queryName) {
        const project = projects.find(project => project.name.toLowerCase() === queryName.toLowerCase());
        if (!project) {
            res.status(400).send('Project ' + queryName + ' not found');
            return;
        }
        if (!project.documentation) {
            res.status(400).send('No documentation found.');
            return;
        }
        projectsToSearch.push(project);
    } else {
        projectsToSearch = projects.filter(project => project.documentation);
    }
    if (projectsToSearch.length === 0) {
        res.status(400).send('No documentation found.');
        return;
    }

    // If the query is in the cache, return the cached results
    if (searchCache[query.toLowerCase()]) {
        // ...But only if the query was for the same projectsToSearch
        if (searchCache[query.toLowerCase()].projects.length === projectsToSearch.length) {
            let sameProjects = true;
            for (let i = 0; i < projectsToSearch.length; i++) {
                if (searchCache[query.toLowerCase()].projects[i].name !== projectsToSearch[i].name) {
                    sameProjects = false;
                    break;
                }
            }
            if (sameProjects) {
                res.status(200).send(searchCache[query.toLowerCase()].results);
                return;
            }
        }
    }

    const results = [];
    for (let project of projectsToSearch) {
        // List page names that end with .md from the content
        const pages = fs.readdirSync(path.join(content, `docs/${project.name.toLowerCase()}`));
        for (const page of pages) {
            if (page.endsWith('.md')) {
                // Search against the page name and content
                let pageName = page.slice(0, -3);
                let nameMatches = searchPage(query, pageName);
                let contentMatches = searchPage(query, fs.readFileSync(path.join(content, `docs/${project.name.toLowerCase()}/${page}`), 'utf8'));

                // Ignore meta pages (_Sidebar, _Footer & Home)
                if (pageName.startsWith('_') || pageName === 'Home') {
                    continue;
                }

                // Add the page to the results if it contains the query
                if (nameMatches.length + contentMatches.length > 0) {
                    results.push({
                        'project': project.name,
                        'name': pageName.replace(/-/g, ' '),
                        'url': `/docs/${project.name.toLowerCase()}/${pageName}`,
                        'name_matches': nameMatches.length,
                        'content_matches': contentMatches.length,
                    });
                }
            }
        }
    }

    // Sort results by name matches first, followed by content matches
    results.sort((a, b) => {
        if (a.name_matches === b.name_matches) {
            return b.content_matches - a.content_matches;
        }
        return b.name_matches - a.name_matches;
    });

    // Limit to first 15 results
    results.splice(15);

    // Cache the result for this query
    searchCache[query.toLowerCase()] = {
        'projects': projectsToSearch,
        'results': results,
    };

    res.send(results);
});


// Serves a list of all projects and data
app.get('/api/projects', (req, res) => {
    res.send(projects);
});


// Serves data about a specific project by name
app.get('/api/projects/:name', (req, res) => {
    const name = req.params.name;
    const project = projects.find(project => project.name.toLowerCase() === name.toLowerCase());
    if (project) {
        res.send(project);
    } else {
        res.status(404).send('Not found');
    }
});

// Serves data about the version history of a specific project by name via Spiget
app.get('/api/projects/:name/versions', (req, res) => {
    const project = projects.find(project => project.name.toLowerCase() === req.params.name.toLowerCase());
    if (project) {
        let id = project.ids.spigot;
        let results = req.query.results;
        if (!results) {
            results = 10;
        }
        results = results < 1 ? 1 : results > 100 ? 100 : results;
        if (id) {
            spiget.getResourceVersions(id, new Pagination(results, 1, '-releaseDate')).then(resourceVersions => {
                res.send({
                    'latest': {
                        'number': resourceVersions[0].name,
                        'published': resourceVersions[0].releaseDate,
                    },
                    'versions': resourceVersions.map(version => {
                        return {
                            'number': version.name,
                            'published': version.releaseDate,
                        };
                    })
                });
            });
        } else {
            res.status(400).send('No Spigot ID for project');
        }
    } else {
        res.status(404).send('Not found');
    }
});

// Prepare the sitemap and server settings
app.use(['/api/projects', '/api/projects/:name', '/api/projects/:name/versions', '/api/update-docs', '/api/search-docs/(:name)?', '/api/search-docs'], limiter);

// Handle sitemap requests
let cachedSitemap;
app.get('/sitemap.xml', (req, res) => {
    res.header('Content-Type', 'application/xml');
    res.header('Content-Encoding', 'gzip');

    const location = 'London, United Kingdom';

    // Returned cached sitemap if it exists
    if (cachedSitemap) {
        res.send(cachedSitemap)
        return;
    }

    // Generate sitemap
    try {
        const sitemapStream = new SitemapStream({
            hostname: domain
        });
        const pipeline = sitemapStream.pipe(createGzip())

        // Write pages
        sitemapStream.write({
            url: '/',
            changefreq: 'daily',
            lastmod: new Date().toISOString(),
            priority: 1,
            img: {
                url: '/images/icons/williamhead.png'
            }
        });
        sitemapStream.write({
            url: '/docs/',
            changefreq: 'daily',
            lastmod: fs.statSync(path.join('pages', 'home.pug')).mtime.toISOString(),
            priority: 0.9
        });

        // Iterate through every .md file in the content/docs directory and subdirectories
        for (const project of projects) {
            if (project.repository && project.documentation) {
                for (const page of fs.readdirSync(path.join(content, `docs/${project.id}`))) {
                    if (page.endsWith('.md') && !page.startsWith('_') && page !== 'Home.md') {
                        let pageName = page.slice(0, -3);
                        if (project.icons && project.icons.png) {
                            sitemapStream.write({
                                url: `/docs/${project.id}/${pageName}`,
                                changefreq: 'daily',
                                lastmod: fs.statSync(path.join(content, `docs/${project.id}/${page}`)).mtime.toISOString(),
                                priority: 0.8,
                                img: {
                                    url: `/images/icons/${project.icons.png}`
                                }
                            });
                        } else {
                            sitemapStream.write({
                                url: `/docs/${project.id}/${pageName}`,
                                changefreq: 'daily',
                                lastmod: fs.statSync(path.join(content, `docs/${project.id}/${page}`)).mtime.toISOString(),
                                priority: 0.8,
                            });
                        }
                    }
                }
            }
            if (project.readme) {
                if (project.readme.startsWith('/')) {
                    if (fs.existsSync(path.join(content, `${project.readme}.md`))) {

                        if (project.icons && project.icons.png) {
                            sitemapStream.write({
                                url: project.readme,
                                changefreq: 'daily',
                                lastmod: fs.statSync(path.join(content, `${project.readme}.md`)).mtime.toISOString(),
                                priority: 0.9,
                                img: {
                                    url: `/images/icons/${project.icons.png}`,
                                }
                            });
                        } else {
                            sitemapStream.write({
                                url: project.readme,
                                changefreq: 'daily',
                                lastmod: fs.statSync(path.join(content, `${project.readme}.md`)).mtime.toISOString(),
                                priority: 0.9
                            });
                        }
                    }
                }
            }
        }

        sitemapStream.end();
        pipeline.pipe(res).on('error', (error) => {
            throw error;
        });
    } catch (error) {
        console.error(error)
        res.status(500).end('Internal error generating sitemap');
    }
});

// Handle robots.txt
app.get('/robots.txt', (req, res) => {
    res.send();
});


// Handle all other page requests
app.get('*', (req, res) => {
    let fullUrl = path.join(content, req.url);
    let urlModifiers = '';

    // If the request ends with a forward slash, redirect to the same page without the forward slash
    if (req.url.endsWith('/')) {
        res.redirect(req.url.slice(0, -1));
        return;
    }

    // If the file doesn't exist, serve the 404 page
    if (!fs.existsSync(fullUrl)) {
        if (!fs.existsSync(fullUrl + '.md')) {
            sendError(res, '404');
            return;
        } else {
            urlModifiers = '.md';
        }
    }

    // If the file is a .md (Markdown) readme file, parse it and serve it as HTML
    if (fullUrl.endsWith('.md') || urlModifiers === '.md') {
        let pageName = req.url.replace(/-/g, ' ').substring(1, req.url.length);
        res.render('readme', {
            'version': version,
            'name': pageName,
            'markdown': markdown.render(fs.readFileSync(path.join(content, req.url + urlModifiers), 'utf8')),
            'title': `${pageName.charAt(0).toUpperCase() + pageName.slice(1)} - William278.net`,
            'description': `Easily-accessible documentation and information site for all of William278's Minecraft plugins, projects & games`,
            'breadcrumbs': generateBreadcrumbs(req.url),
            'organization': ORGANIZATION
        })
    } else {
        res.sendFile(req.url + urlModifiers, {root: content});
    }
});


// Display an error page with a code and description
const sendError = (res, code, description) => {
    res.render('error', {
        'version': version,
        'code': code,
        'details': description ? description : 'Make sure you entered the correct URL.',
        'title': `Error ${code} - William278.net`,
        'description': `Error ${code} - ${description ? description : 'Make sure you entered the correct URL.'}`,
        'breadcrumbs': generateBreadcrumbs(domain + '/error-' + code),
        'organization': ORGANIZATION
    });
}

// Generates structured data breadcrumbs for the current page
const BREADCRUMB_FORMAT = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    'itemListElement': []
}
const generateBreadcrumbs = (url) => {
    let breadcrumbs = JSON.parse(JSON.stringify(BREADCRUMB_FORMAT));
    let doneEndpoints = [];
    url = url.replace('https://william278.net/', '');
    let currentParts = '';
    url.split('/').forEach((part, index) => {
        currentParts += part !== '' ? part + '/' : '';
        let pageName = part.replace(/-/g, ' ');
        if (pageName === 'Home') {
            return;
        }
        if (part === '') {
            pageName = 'Home';
        }
        // if the page name matches a project name in lower case use that
        for (const project of projects) {
            if (project.name.toLowerCase() === pageName.toLowerCase()) {
                pageName = project.name;
                break;
            }
        }
        if (doneEndpoints.includes(domain + '/' + currentParts)) {
            return;
        }
        doneEndpoints += domain + currentParts;
        breadcrumbs.itemListElement.push({
            '@type': 'ListItem',
            'position': index + 1,
            'name': pageName.charAt(0).toUpperCase() + pageName.slice(1),
            'item': domain + '/' + currentParts
        });
    });
    return JSON.stringify(breadcrumbs);
}


// Updates plugin documentation
const updateDocs = (repository, name) => {
    let wiki = repository + '.wiki.git';

    // Check if the content /docs directory exists, if it does not create it
    if (!fs.existsSync(path.join(content, 'docs'))) {
        fs.mkdirSync(path.join(content, 'docs'));
    }

    // Pull docs from the wikis
    const filePath = path.join(content, `docs/${name.toLowerCase()}`);
    git(wiki, filePath, function (err) {
        if (err) {
            console.error('An error occurred pulling ' + wiki + ' to ' + filePath)
            console.error(err);
            return;
        }
        console.log('Updated project documentation for ' + name);
    });
}


// Update all project documentation
console.log('Updating project documentation...');
projects.filter(project => project.documentation).forEach(project => {
    updateDocs(project.repository, project.name);
});

// Serve the web application
app.set('view engine', 'pug');
app.set('views', 'pages')

app.listen(port, host, () => {
    console.log(`Server running at on ${host}:${port}`);
    console.log('[Pterodactyl] Ready');
});