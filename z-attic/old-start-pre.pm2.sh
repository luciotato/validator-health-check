set -e
npm run build 
cp -ur bash-scripts/* dist/
cd dist 
node main >>validator-health.log & 
disown -h
