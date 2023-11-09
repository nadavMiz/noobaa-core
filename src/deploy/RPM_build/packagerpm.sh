#!/bin/bash

set -eou pipefail
set -x

dir=$(dirname "$0")

SKIP_NODE_INSTALL=1 source $dir/../install_nodejs.sh
NODE_PATH="${NODE_PATH:-/usr/local/node}"

noobaaver="$(npm pkg get version | tr -d '"')"
releasedate=$(date '+%a %b %d %Y')
revision="$(date -u '+%Y%m%d')"
nodever=$(node --version | tr -d 'v')
changelogdata="Initial release of NooBaa ${noobaaver}"
ARCHITECTURE=$(uname -m)

TEMPLATE_FILE="${dir}/noobaa.spec"
OUTPUT_FILE="${dir}/noobaa.final.spec"

TARGET_DIR="$1"
TAR_DIR="$2"

function set_changelog() {
    if [ -f $dir/changelog.txt ]; then
        local path=$(realpath $dir/changelog.txt)
        changelogdata="%{lua: print(io.open(\"$path\"):read(\"*a\"))}"
    fi
}

function move_builds() {
    mv ${TAR_DIR}/noobaa-core.tar.gz ${TAR_DIR}/noobaa-core-${noobaaver}-${revision}.tar.gz
    cp ${TAR_DIR}/noobaa-core-${noobaaver}-${revision}.tar.gz ~/rpmbuild/SOURCES/
}

function get_node_tar() {
    local arch=$(get_arch)
    local filename="node-v${nodever}-linux-${arch}.tar.xz"

    pushd ~/rpmbuild/SOURCES/
    if [ -f ${NODE_PATH}/${filename} ]
    then
        mv ${NODE_PATH}/${filename} node-${nodever}.tar.xz
    else 
        local path=$(NODEJS_VERSION=${nodever} download_node)
        mv ${path} node-${nodever}.tar.xz
    fi
    popd
}

function generate_spec_from_template() {
    while IFS= read -r line; do
        # Check if the line starts with '%define' and contains 'null'
        if [[ $line =~ ^%define[[:space:]]+([^[:space:]]+)[[:space:]]+null$ ]]; then
            # Extract the variable name
            VAR_NAME="${BASH_REMATCH[1]}"

            # Get the value of the variable
            VAR_VALUE=$(eval echo "\${${VAR_NAME}}")

            # Replace 'null' with the variable value
            line="${line/null/$VAR_VALUE}"
        fi

        # Write the updated line to the output file
        echo "$line" >>"${OUTPUT_FILE}"
    done <"${TEMPLATE_FILE}"
}

# Create the necessary directories
mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# Move the binary into the SOURCES directory
move_builds

# Download nodejs tarball to SOURCES directory
get_node_tar

# Set the changelog
set_changelog

# Generate spec file from template
generate_spec_from_template

# Print the generated spec file if NRPM_DEBUG is set to true
[[ "${NRPM_DEBUG:-false}" == "true" ]] && cat ${OUTPUT_FILE}

# Move the spec file to the SPECS directory
mv ${OUTPUT_FILE} ~/rpmbuild/SPECS/

# Build the RPM package
rpmbuild -ba ~/rpmbuild/SPECS/noobaa.final.spec

# Move the RPM and SRPM package to the target directory
mv ~/rpmbuild/RPMS/${ARCHITECTURE}/noobaa-core-${noobaaver}-${revision}.*.rpm ${TARGET_DIR}
mv ~/rpmbuild/SRPMS/noobaa-core-${noobaaver}-${revision}.*.rpm ${TARGET_DIR}
