#!/usr/bin/env python3

from concurrent.futures import ThreadPoolExecutor
import optparse
import os
import sys
import urllib.error
import urllib.request


def run_cmd(cmd, exit_on_fail=True, do_print=True, no_execute=False):
    if cmd != '':
        if do_print:
            print(cmd)
        if not no_execute:
            retval = os.system(cmd)
            if retval != 0 and exit_on_fail:
                print("fatal error: command '{}' failed".format(cmd))
                sys.exit(1)
            return retval
    return None


def get_version_from_file(version_filename='./version'):
    with open(version_filename) as f:
        lines = f.readlines()
        if len(lines) != 1:
            sys.stderr.write('error: ./version contains too many lines.')
            sys.exit(1)
        return lines[0].strip()


def make_version_string(major, minor, patch):
    if patch == 0:
        return '{}.{}'.format(major, minor)
    return '{}.{}.{}'.format(major, minor, patch)


def firefox_release_url(ver):
    return 'https://archive.mozilla.org/pub/firefox/releases/{}/source/firefox-{}.source.tar.xz'.format(ver, ver)


def check_url_exists(url, timeout=15):
    req = urllib.request.Request(
        url,
        method='HEAD',
        headers={'User-Agent': 'argon-update-version/1.0'},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 400
    except urllib.error.HTTPError as err:
        return 200 <= err.code < 400
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def main():
    parser = optparse.OptionParser()
    parser.add_option('-n', '--no-execute', dest='no_execute', default=False, action="store_true")
    options, _ = parser.parse_args()

    base_version = get_version_from_file()

    # split base_version into major.minor.patch
    split_version = base_version.split(sep='.')
    if len(split_version) > 3 or len(split_version) < 1:
        sys.stderr.write('error: ./version file contains invalid version number')
        sys.exit(1)
    elif len(split_version) == 1:
        major = int(split_version[0])
        minor = 0
        patch = 0
    elif len(split_version) == 2:
        major = int(split_version[0])
        minor = int(split_version[1])
        patch = 0
    else:
        major = int(split_version[0])
        minor = int(split_version[1])
        patch = int(split_version[2])

    current_ver = make_version_string(major, minor, patch)
    candidates = [
        ('{}.{}.{}'.format(major, minor, patch + 1), firefox_release_url(make_version_string(major, minor, patch + 1))),
        ('{}.{}'.format(major, minor + 1), firefox_release_url(make_version_string(major, minor + 1, 0))),
        ('{}.0'.format(major + 1), firefox_release_url(make_version_string(major + 1, 0, 0))),
    ]
    all_urls = [firefox_release_url(current_ver)] + [url for _, url in candidates]

    with ThreadPoolExecutor(max_workers=len(all_urls)) as pool:
        results = list(pool.map(check_url_exists, all_urls))

    if not results[0]:
        sys.stderr.write('error: The current version is unavailable.')
        sys.exit(1)

    next_version = base_version
    for (label, _), exists in zip(candidates, results[1:]):
        if exists:
            next_version = label
            break

    if next_version != base_version:
        print('The wheel has turned, and version {} has been released.'.format(next_version))
        if not options.no_execute:
            with open('./version', 'w') as f:
                f.write(next_version)
            run_cmd('echo 1 > release', no_execute=options.no_execute)
    else:
        print('Latest Firefox release is still {}.'.format(base_version))

    sys.exit(0)  # ensure 0 exit code


if __name__ == '__main__':
    main()
